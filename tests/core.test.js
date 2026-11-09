// Hesap çekirdeğinin testleri: bilinen sinyallerle FFT/PSD, hız RMS, zarf, ISO,
// rulman analizi, paket kaybı ve kalite kontrolü. Çalıştırma: `npm test`
// (Node 18+; ek kütüphane gerekmez).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { APP_FILES, load } = require('./extract');

const FS = 6510;      // sensör örnekleme hızı (Hz)
const N = 12800;      // tipik bir ölçümdeki örnek sayısı
const G = 9.80665;

// Tekrarlanabilir sözde-rastgele normal dağılım (testler her seferinde aynı sonucu versin).
function rng(seed){
  let s = seed;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}
const signal = (fn) => Float64Array.from({ length: N }, (_, k) => fn(k / FS, k));
const sine = (f, a) => (t) => a * Math.sin(2 * Math.PI * f * t);

for(const file of APP_FILES){
  const api = load(file, {
    // assessSignalQuality global axisSamples'ı okur; testten doldurabilmek için erişimci.
    prelude: 'var SAMPLE_RATE_HZ = 6510; var SCALE_G_PER_LSB = 0.0006104; var axisSamples = {}; function getAxisSamples(){ return axisSamples; }',
    exports: ['getAxisSamples', 'shaftFaultBreakdown', 'estimateMainsBase', 'estimateDriveFe', 'validDriveFe', 'normalizePsdForAnalysis', 'nearBearingFreq', 'bearingFaultIndex', 'axisRoleOf', 'axialMisalignmentCheck', 'bfiSummaryOf', 'evaluateBfiTrend', 'blindLineNotes'],
    names: ['parseSensorSampleRate', 'nextPow2', 'fft', 'ifft', 'computePSD', 'envelopeSpectrum',
      'velocitySpectrumFromAccelPSD', 'rmsAccelFromPSD', 'downsampleSpectrum',
      'ISO_ZONES', 'isoClass', 'isoEvaluate', 'ISO_BASIS_TEXT', 'isoLowSpeedNote', 'velBandLow',
      'escapeHtml', 'findSeqGaps', 'ENV_SPEC_F_MAX',
      'Q_CLIP_LSB', 'Q_CLIP_MIN_COUNT', 'Q_FLAT_STD_LSB', 'Q_STUCK_RUN', 'Q_SPIKE_LSB', 'Q_LEN_MISMATCH',
      'SKI_BLOCK_S', 'SKI_DRIFT_RATIO', 'SKI_DRIFT_MIN_G', 'SKI_BAND', 'SKI_VEL_RATIO', 'SKI_VEL_MIN', 'skiSlopeCheck',
      'TWF_HP_HZ', 'TWF_EDGE_FRAC', 'TWF_MIN_RMS_G', 'CF_WARN', 'CF_HIGH', 'KURT_WARN', 'KURT_HIGH', 'biquadHighpass', 'biquadRun', 'highpassFiltFilt', 'twfStatsOf', 'computeTwfStats', 'twfVerdict', 'evaluateCfTrend',
      'ELEC_PEAK_GATE', 'ELEC_SHARE_MIN', 'localPeak', 'localFloor', 'electricalCheck', 'SB_GATE', 'sidebandCheck', 'CARPET_TREND', 'CARPET_SHAPE', 'CARPET_MIN_PSD', 'bandMedian', 'carpetCheck', 'VFD_COMB_SHARE', 'VFD_MIN_LINES', 'VFD_LINE_GATE', 'vfdCarrierCheck', 'velLineSpectrum', 'downsampleSpectrum', 'VEL_SPEC_MODE', 'fixDocVelSpectrum', 'SAMPLE_RATE_DEFAULT_HZ', 'VEL_F_LOW', 'twfSummaryOf', 'evaluateImpactTrend', 'SUB_ENERGY_SHARE', 'SUB_MIN_MMS', 'SUB_NARROW_HZ', 'subSyncCheck',
      'assessSignalQuality', 'medianOfNums', 'ENV_LINE_GATE', 'ENV_LINE_FLOOR_HZ', 'ENV_LINE_MAX_HALF_HZ', 'suppressDriveLines', 'envOptsFor', 'shaftScale', 'effectiveShaftHz', 'decodeRawBuffer', 'strongPsdMatches'],
    regions: [['const MAINS_HZ', 'analyzeBearing']],
  });

  test(`${file}: sensörün bildirdiği örnekleme hızı okunuyor`, () => {
    const b = new Uint8Array(16); b[14] = 0x70; b[15] = 0x19; // 0x1970 = 6512 Hz
    assert.equal(api.parseSensorSampleRate(new DataView(b.buffer)), 6512);
    assert.equal(api.parseSensorSampleRate(new DataView(new ArrayBuffer(8))), null, 'kısa cevap');
    assert.equal(api.parseSensorSampleRate(new DataView(new ArrayBuffer(16))), null, 'aralık dışı (0 Hz)');
  });

  test(`${file}: PSD alanı sinyalin varyansına eşit (Parseval) ve tepe doğru frekansta`, () => {
    const g = rng(1);
    const x = signal((t) => 0.05 * g() + sine(87.3, 0.5)(t));
    const { freqs, psd } = api.computePSD(x, FS);
    const df = freqs[1] - freqs[0];
    let area = 0, peak = 1;
    for(let k = 1; k < psd.length; k++){ area += psd[k] * df; if(psd[k] > psd[peak]) peak = k; }
    const variance = x.reduce((s, v) => s + v * v, 0) / x.length;
    assert.ok(Math.abs(area / variance - 1) < 0.03, `alan/varyans = ${(area / variance).toFixed(3)}`);
    assert.ok(Math.abs(freqs[peak] - 87.3) <= df, `tepe ${freqs[peak].toFixed(2)} Hz`);
  });

  test(`${file}: ivmeden hız RMS'i fiziksel formülle uyumlu`, () => {
    // A g genlikli f Hz ivme → hız RMS = A·g/(2πf)/√2 (mm/s)
    for(const [f, a] of [[24.15, 0.3], [100, 0.5], [400, 1]]){
      const { freqs, psd } = api.computePSD(signal(sine(f, a)), FS);
      const { rmsVelocity } = api.velocitySpectrumFromAccelPSD(freqs, psd, 10, 1000);
      const expected = a * G / (2 * Math.PI * f) / Math.SQRT2 * 1000;
      assert.ok(Math.abs(rmsVelocity / expected - 1) < 0.03,
        `${f} Hz: ${rmsVelocity.toFixed(3)} mm/s, beklenen ${expected.toFixed(3)}`);
    }
  });

  test(`${file}: 10–1000 Hz bandı dışındaki bileşen hız RMS'ine girmiyor`, () => {
    const { freqs, psd } = api.computePSD(signal(sine(5, 0.5)), FS);
    const { rmsVelocity } = api.velocitySpectrumFromAccelPSD(freqs, psd, 10, 1000);
    assert.ok(rmsVelocity < 0.5, `5 Hz için ${rmsVelocity.toFixed(3)} mm/s`);
  });

  test(`${file}: zarf spektrumu modülasyon frekansını buluyor`, () => {
    // 2000 Hz taşıyıcı, 87 Hz ile genlik modülasyonu (rulman darbesi benzetimi)
    const x = signal((t) => (1 + 0.8 * Math.sin(2 * Math.PI * 87 * t)) * Math.sin(2 * Math.PI * 2000 * t));
    const { freqs, amp } = api.envelopeSpectrum(x, FS, 1300, 2800);
    let peak = 0;
    for(let k = 0; k < amp.length; k++){ if(freqs[k] > 10 && freqs[k] < 500 && amp[k] > (amp[peak] || 0)) peak = k; }
    assert.ok(Math.abs(freqs[peak] - 87) < 1, `zarf tepesi ${freqs[peak].toFixed(2)} Hz`);
  });

  test(`${file}: ISO 10816-3 grup/temel ve bölge sınırları`, () => {
    assert.equal(api.isoClass(11, 'rijit'), 'I', '≤15 kW → 10816-1 Sınıf I');
    assert.equal(api.isoClass(15, 'esnek'), 'I');
    assert.equal(api.isoClass(55, 'rijit'), 'G2R');
    assert.equal(api.isoClass(300, 'esnek'), 'G2F');
    assert.equal(api.isoClass(315, 'rijit'), 'G1R');
    assert.equal(api.isoClass(800, 'esnek'), 'G1F');
    assert.equal(api.isoClass(null), null);
    // ISO 10816-3 Tablo A.1 / A.2 (mm/s RMS)
    assert.deepEqual(Array.from(api.ISO_ZONES.G2R), [1.4, 2.8, 4.5]);
    assert.deepEqual(Array.from(api.ISO_ZONES.G2F), [2.3, 4.5, 7.1]);
    assert.deepEqual(Array.from(api.ISO_ZONES.G1R), [2.3, 4.5, 7.1]);
    assert.deepEqual(Array.from(api.ISO_ZONES.G1F), [3.5, 7.1, 11.0]);
    assert.equal(api.isoEvaluate(1.4, 'G2R').zone, 'A', 'sınır dahil');
    assert.equal(api.isoEvaluate(1.41, 'G2R').zone, 'B');
    assert.equal(api.isoEvaluate(4.5, 'G2R').zone, 'C');
    assert.equal(api.isoEvaluate(4.6, 'G2R').zone, 'D');
    assert.equal(api.isoEvaluate(3, null), null);
  });

  test(`${file}: 600 rpm altında bant uyarısı, üstünde değil`, () => {
    assert.match(api.isoLowSpeedNote('450'), /600 rpm altı/);
    assert.equal(api.isoLowSpeedNote('1449'), '');
    assert.equal(api.isoLowSpeedNote('—'), '');
    assert.match(api.ISO_BASIS_TEXT, /10816-3/);
  });

  test(`${file}: 600 rpm altında hız bandı devre göre iniyor, 1× bandın içinde`, () => {
    assert.equal(api.velBandLow('1490'), 10);
    assert.equal(api.velBandLow('600'), 10);
    assert.equal(api.velBandLow('—'), 10);
    assert.equal(api.velBandLow('500'), 5.8);   // 0.7 × 8.33 Hz
    assert.equal(api.velBandLow('100'), 2);     // alt sınır 2 Hz
    // 500 rpm'de 1× (8.33 Hz) hız RMS'ine eski bantta girmiyor, yeni bantta giriyor.
    const f1 = 500 / 60, a = 0.05;
    const { freqs, psd } = api.computePSD(signal(sine(f1, a)), FS);
    const old = api.velocitySpectrumFromAccelPSD(freqs, psd, 10, 1000).rmsVelocity;
    const neu = api.velocitySpectrumFromAccelPSD(freqs, psd, api.velBandLow('500'), 1000).rmsVelocity;
    const expected = a * G / (2 * Math.PI * f1) / Math.SQRT2 * 1000;
    assert.ok(old < 0.2 * expected, `eski bant ${old.toFixed(2)} mm/s`);
    assert.ok(Math.abs(neu / expected - 1) < 0.05, `yeni bant ${neu.toFixed(2)}, beklenen ${expected.toFixed(2)}`);
    assert.match(api.isoLowSpeedNote('500', 5.8), /5\.8–1000 Hz/);
    assert.match(api.isoLowSpeedNote('500'), /10–1000 Hz/);
  });

  test(`${file}: yerçekimi (DC) düşük devir bandında hız RMS'ini şişirmiyor`, () => {
    const g = rng(91);
    const x = signal((t) => 1 + 0.002 * g());   // 1 g sabit + küçük gürültü
    const { freqs, psd } = api.computePSD(x, FS);
    const { rmsVelocity } = api.velocitySpectrumFromAccelPSD(freqs, psd, 2, 1000);
    assert.ok(rmsVelocity < 0.3, `${rmsVelocity.toFixed(3)} mm/s`);
  });

  test(`${file}: 500 rpm'de 3× ile çakışan BPFO için çözünürlük notu`, () => {
    const lvl1 = [{ key: 'BPFO', level: 1 }, { key: 'BPFI', level: 1 }];
    const low = 500 / 60;   // 6313: BPFO 3.0708× = 25.6 Hz, 3× = 25.0 Hz
    const nLow = api.blindLineNotes(lvl1, low, 50, { BPFO: 3.0708 * low, BPFI: 4.9292 * low });
    assert.equal(nLow.length, 1);
    assert.match(nLow[0], /BPFO 25\.6 Hz/);
    const high = 1490 / 60;
    assert.equal(api.blindLineNotes(lvl1, high, 50, { BPFO: 3.0708 * high, BPFI: 4.9292 * high }).length, 0);
    // Bulgu varsa (Seviye 2+) bu not yerine orderOverlapNotes devreye girer.
    assert.equal(api.blindLineNotes([{ key: 'BPFO', level: 2 }], low, 50, { BPFO: 3.0708 * low }).length, 0);
  });

  test(`${file}: HTML kaçışı`, () => {
    assert.equal(api.escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    assert.equal(api.escapeHtml(null), '');
    assert.equal(api.escapeHtml(1449), '1449');
  });

  test(`${file}: paket sıra numarasındaki boşluklar bulunuyor`, () => {
    const p = (...s) => s.map(seq => ({ seq }));
    assert.deepEqual(Array.from(api.findSeqGaps(p(0, 1, 2, 3))), []);
    assert.deepEqual(Array.from(api.findSeqGaps(p(0, 1, 4, 5, 7))), [2, 3, 6]);
  });

  test(`${file}: kalite kontrolü sağlam sinyali geçiriyor, doygun/ölü sinyali yakalıyor`, () => {
    const S = 0.0006104, g = rng(2);
    const q = (fn) => Float32Array.from({ length: N }, (_, k) => Math.max(-32768, Math.min(32767, Math.round(fn(k)))) * S);
    const ok = () => q(() => 1638 + 30 * g());
    const run = (X) => { Object.assign(api.getAxisSamples(), { X, Y: ok(), Z: ok() }); return api.assessSignalQuality(); };
    assert.deepEqual(Array.from(run(q((k) => 16000 * Math.sin(2 * Math.PI * 25 * k / FS) + 20 * g()))), [], '10 g sinüs sağlam');
    assert.match(run(q((k) => 41000 * Math.sin(2 * Math.PI * 25 * k / FS))).join(), /doygun/);
    assert.match(run(q(() => 1638)).join(), /sinyal yok/);
    assert.match(run(q((k) => (k > 5000 && k < 5200) ? 777 : 30 * g())).join(), /takılma/);
  });

  test(`${file}: PSD'de tek başına Seviye 3 — devir katına yakın / tutarsız harmonik yetmez`, () => {
    const shaft = 24.05; // 332/3B, 09:44 kaydı
    const c = (h, target, freq) => ({ key: 'BPFO', h, target, freq });
    // 1× 74.2 Hz 3× devire (72.2) %3 yakın; 3× 226.2 Hz ise 3·74.2=222.6'dan 3.6 Hz kaçık
    const reportCase = [c(1, 74.5, 74.2), c(3, 223.4, 226.2)];
    assert.ok(api.strongPsdMatches(reportCase, shaft, 0.4).length < 2, 'rapordaki eşleşmeler Seviye 3 için yetmemeli');
    assert.ok(api.strongPsdMatches(reportCase, shaft, 5.1).length < 2, 'kaba (kayıtlı) çözünürlükte de');
    // Devir katından uzak, tam katlı harmonikler: güçlü sayılır
    const real = [c(1, 87.3, 87.4), c(2, 174.6, 174.8)];
    assert.equal(api.strongPsdMatches(real, 24.15, 0.4).length, 2);
    // Devir katından uzak ama 2× tutarsız (1.5 Hz kaçık, df 0.4): güçlü sayılmaz
    assert.equal(api.strongPsdMatches([c(1, 87.3, 87.4), c(2, 174.6, 176.3)], 24.15, 0.4).length, 1);
  });

  test(`${file}: rulman analizi gürültüde sessiz, BPFO arızasını buluyor`, () => {
    const bF = { BPFO: 87.3, BPFI: 129.4, BSF: 57.1, FTF: 9.7 };
    const level = (x) => {
      const { freqs, psd } = api.computePSD(x, FS);
      return api.analyzeBearing(freqs, psd, null, bF, { rpm: 1449 });
    };
    const g = rng(3);
    assert.equal(level(signal(() => g())).level, 1, 'saf gürültü → Seviye 1');
    const fault = level(signal((t) => g() + sine(87.3, 0.15)(t) + sine(174.6, 0.1)(t)));
    assert.ok(fault.level >= 2, `arıza seviyesi ${fault.level}`);
    assert.equal(fault.perKey.slice().sort((a, b) => b.level - a.level)[0].key, 'BPFO');
  });

  test(`${file}: otomatik tanı payları doğru kaynağa gidiyor ve toplamı OVL'ye eşit`, () => {
    const fr = 24.6; // 1476 rpm
    // İvme genliğini (g), istenen hız tepe değerinden (mm/s) üret.
    const accFor = (f, vPeakMms) => vPeakMms / 1000 * 2 * Math.PI * f / G;
    const run = (comps, seed) => {
      const g = rng(seed);
      const x = signal((t) => 0.002 * g() + comps.reduce((s, [f, v]) => s + sine(f, accFor(f, v))(t), 0));
      const { freqs, psd } = api.computePSD(x, FS);
      const { velAmp, rmsVelocity } = api.velocitySpectrumFromAccelPSD(freqs, psd, 10, 1000);
      const r = api.shaftFaultBreakdown(freqs, velAmp, fr, 50, rmsVelocity);
      const sum = r.parts.unbalance + r.parts.misalignment + r.parts.looseness + r.parts.other;
      assert.ok(Math.abs(sum - rmsVelocity) < 0.03, `paylar toplamı ${sum} ≠ OVL ${rmsVelocity}`);
      return r;
    };
    const unb = run([[fr, 6], [2 * fr, 1]], 11);
    assert.equal(unb.dominant, 'unbalance');
    assert.ok(unb.shares.unbalance > 0.85, `dengesizlik payı ${unb.shares.unbalance}`);
    const mis = run([[fr, 1.5], [2 * fr, 5], [3 * fr, 1]], 12);
    assert.equal(mis.dominant, 'misalignment');
    const loose = run([[fr, 1], [1.5 * fr, 2], [3 * fr, 3], [4 * fr, 2.5], [5 * fr, 2]], 13);
    assert.equal(loose.dominant, 'looseness');
    // Devirle ilgisiz tepe (rulman 87.3 Hz + şebeke 100 Hz) → "diğer".
    const oth = run([[87.3, 4], [100, 3], [fr, 0.5]], 14);
    assert.equal(oth.dominant, null);
    assert.ok(oth.shares.other > 0.8, `diğer payı ${oth.shares.other}`);
    // 2× devir şebekeyle iç içe (24.9 Hz → 49.8 Hz): saf 50 Hz şebeke çizgisi hizalama sayılmamalı.
    const g = rng(15);
    const xm = signal((t) => 0.002 * g() + sine(50, accFor(50, 4))(t));
    const sp = api.computePSD(xm, FS);
    const vm2 = api.velocitySpectrumFromAccelPSD(sp.freqs, sp.psd, 10, 1000);
    const rm = api.shaftFaultBreakdown(sp.freqs, vm2.velAmp, 24.9, 50, vm2.rmsVelocity);
    assert.notEqual(rm.dominant, 'misalignment', `şebeke çizgisi hizalama sanıldı (${rm.shares.misalignment})`);
    assert.equal(api.shaftFaultBreakdown(sp.freqs, vm2.velAmp, null, 50, 1), null, 'devir yoksa null');
  });

  test(`${file}: rulman skoru (BFI) gürültüde düşük, BPFO darbelerinde yüksek`, () => {
    const bF = { BPFO: 87.3, BPFI: 129.4, BSF: 57.1, FTF: 9.7 };
    const fr = 24.4;
    const bfi = (x) => {
      const { freqs, amp } = api.envelopeSpectrum(x, FS, 1300, 2800);
      const d = api.downsampleSpectrum(freqs, amp, 200, 0, api.ENV_SPEC_F_MAX, 'max'); // kayıt biçimi
      return api.bearingFaultIndex(d.f, d.v, bF, fr, 50, true);
    };
    const g = rng(21);
    const noise = bfi(signal(() => 0.05 * g()));
    assert.ok(noise.value < 8, `gürültüde BFI ${noise.value}`);
    // BPFO hızında tekrarlanan, 2 kHz'de çınlayan darbeler (dış bilezik hasarı modeli)
    const g2 = rng(22);
    const T = 1 / 87.3;
    const fault = bfi(signal((t) => {
      const tau = t % T;
      return 0.05 * g2() + 0.6 * Math.exp(-tau * 900) * Math.sin(2 * Math.PI * 2000 * tau);
    }));
    assert.equal(fault.top, 'BPFO');
    assert.ok(fault.value > 40, `arızada BPFO skoru ${fault.value}`);
    assert.ok(fault.scores.BPFI < fault.value / 3, `BPFI ${fault.scores.BPFI}`);
    assert.equal(api.bearingFaultIndex(null, null, bF, fr, 50, true), null);
  });

  test(`${file}: sensör yönelimi ve eksenel 1× kuralı`, () => {
    const o = { axial: 'Z', vertical: 'X' };
    assert.equal(api.axisRoleOf('Z', o), 'axial');
    assert.equal(api.axisRoleOf('X', o), 'vertical');
    assert.equal(api.axisRoleOf('Y', o), 'horizontal');
    assert.equal(api.axisRoleOf('Y', { axial: 'Z', vertical: null }), null, 'dikey bilinmiyorsa kalan eksen belirsiz');
    assert.equal(api.axisRoleOf('X', null), null);
    const ax = (u) => ({ parts: { unbalance: u, misalignment: 0, looseness: 0, other: 0 } });
    const hit = api.axialMisalignmentCheck({ X: ax(3), Y: ax(2), Z: ax(2.1) }, o);
    assert.ok(hit && Math.abs(hit.ratio - 0.7) < 1e-9, 'eksenel 1× radyalin %70’i → uyarı');
    assert.equal(api.axialMisalignmentCheck({ X: ax(3), Y: ax(2), Z: ax(0.6) }, o), null, 'eksenel düşük → saf dengesizlik');
    assert.equal(api.axialMisalignmentCheck({ X: ax(0.6), Y: ax(0.5), Z: ax(0.4) }, o), null, 'çok düşük seviye yorumlanmaz');
    assert.equal(api.axialMisalignmentCheck({ X: ax(3), Y: ax(2), Z: ax(3) }, null), null, 'yönelim yok');
  });

  test(`${file}: rulman skoru uyarı kuralı (yüksek / artan / teyit)`, () => {
    const s = api.bfiSummaryOf({ X: { BPFO: 12, BPFI: 3, BSF: 0 }, Y: null, Z: { BPFO: 2, BPFI: 41, BSF: 5 } });
    assert.deepEqual({ ...s }, { value: 41, ax: 'Z', key: 'BPFI' });
    assert.equal(api.bfiSummaryOf(null), null);
    const r = (...vals) => vals.map(v => ({ bfi: v == null ? null : { value: v, ax: 'X', key: 'BPFO' } }));
    assert.equal(api.evaluateBfiTrend(r(5, 8, 6, 10)), null, 'düşük ve sabit');
    const rising = api.evaluateBfiTrend(r(5, 8, 6, 35));
    assert.equal(rising.kind, 'rising'); assert.equal(rising.confirmed, false);
    assert.equal(api.evaluateBfiTrend(r(5, 8, 32, 36)).confirmed, true, 'art arda ikinci artış teyitli');
    assert.equal(api.evaluateBfiTrend(r(25, 28, 30, 38)), null, 'zaten yüksek seyreden, 15 puan artmamış');
    assert.equal(api.evaluateBfiTrend(r(65)).kind, 'high', 'ilk ölçümde bile %60 üstü');
    assert.equal(api.evaluateBfiTrend(r(null, null, 50)), null, 'geçmişi yok, %60 altında');
  });
  // ---- Sürücülü (VFD) motor: taşıyıcı kümesi, zarf bastırma, devir-harmoniği uyarısı ----
  const FE = 48.4, SP = 2 * FE, FC = 2098;
  // PWM taşıyıcısı ve ±2fe / ±4fe yan bantları (ölçülen 332.3B kalıbına benzer)
  const vfdLines = [[FC, 0.5], [FC - SP, 0.35], [FC + SP, 0.35], [FC - 2 * SP, 0.15], [FC + 2 * SP, 0.15]];
  const vfd = (t) => vfdLines.reduce((s, [f, a]) => s + a * Math.sin(2 * Math.PI * f * t + f), 0);
  const envAt = (freqs, amp, f) => { let b = 0; for(let k = 0; k < freqs.length; k++){ if(Math.abs(freqs[k] - f) <= 1.5 && amp[k] > b) b = amp[k]; } return b; };

  test(`${file}: sürücü taşıyıcı kümesinden fe bulunuyor, gürültüde bulunmuyor`, () => {
    const g = rng(31);
    const { freqs, psd } = api.computePSD(signal((t) => 0.05 * g() + vfd(t)), FS);
    const fe = api.estimateDriveFe(api.normalizePsdForAnalysis(freqs, psd));
    assert.ok(fe && Math.abs(fe - FE) < 0.6, `fe ${fe}`);
    const g2 = rng(32);
    const n = api.computePSD(signal(() => 0.05 * g2()), FS);
    assert.equal(api.estimateDriveFe(api.normalizePsdForAnalysis(n.freqs, n.psd)), null);
    // fe devirle tutarlı olmalı (4 kutuplu: fe ≈ 2×devir×(1+kayma))
    assert.equal(api.validDriveFe(48.4, 24.01), 48.4);
    assert.equal(api.validDriveFe(43.65, 24.4), null, 'devirle tutarsız küme reddedilir');
    // 2fe bir rulman frekansına denk geliyorsa bastırma açılmaz
    assert.equal(api.envOptsFor(48.4, { BPFO: 96.8, BPFI: 150, BSF: 40 }, 1), null);
    assert.equal(api.envOptsFor(48.4, { BPFO: 74.3, BPFI: 117.7, BSF: 50.4 }, 1).driveFe, 48.4);
    assert.equal(api.envOptsFor(48.4, null), null, 'rulman bilgisi yoksa bastırma yok');
  });

  test(`${file}: rulman darbe tarağı sürücü izi sanılmıyor`, () => {
    // 6319 @ 24.01 Hz: BPFO 74.3 Hz ≈ 3.1× devir — 6 kutuplu bir motorun fe'sine benzer.
    const shaft = 24.01;
    const bF = { BPFO: 3.0959 * shaft, BPFI: 4.9041 * shaft, BSF: 2.0992 * shaft, FTF: 0.3870 * shaft };
    const g = rng(35);
    const T = 1 / bF.BPFO;
    const x = signal((t) => { const tau = t % T; return 0.002 * g() + vfd(t) + 0.25 * Math.exp(-tau * 900) * Math.sin(2 * Math.PI * 1600 * tau); });
    const { freqs, psd } = api.computePSD(x, FS);
    const norm = api.normalizePsdForAnalysis(freqs, psd);
    const fe = api.estimateDriveFe(norm, shaft, bF);
    assert.ok(fe && Math.abs(fe - FE) < 0.6, `fe ${fe}`);
    // Sürücü kümesi olmadan sadece darbe tarağı: sürücü izi yok
    const g2 = rng(36);
    const y = signal((t) => { const tau = t % T; return 0.002 * g2() + 0.25 * Math.exp(-tau * 900) * Math.sin(2 * Math.PI * 1600 * tau); });
    const q = api.computePSD(y, FS);
    assert.equal(api.estimateDriveFe(api.normalizePsdForAnalysis(q.freqs, q.psd), shaft, bF), null);
  });

  test(`${file}: zarfta sürücü çizgileri bastırılınca rulman darbesi öne çıkıyor`, () => {
    const g = rng(33);
    const T = 1 / 74.3; // BPFO hızında 1600 Hz'de çınlayan darbeler + sürücü kümesi
    const x = signal((t) => {
      const tau = t % T;
      return 0.05 * g() + vfd(t) + 0.25 * Math.exp(-tau * 900) * Math.sin(2 * Math.PI * 1600 * tau);
    });
    const plain = api.envelopeSpectrum(x, FS, 1300, 2800);
    const supp = api.envelopeSpectrum(x, FS, 1300, 2800, { driveFe: FE });
    assert.ok(envAt(plain.freqs, plain.amp, SP) > envAt(plain.freqs, plain.amp, 74.3), 'bastırmasız zarfta 2fe baskın');
    assert.ok(supp.removedLines.length >= 3, `silinen çizgi ${supp.removedLines.length}`);
    assert.ok(envAt(supp.freqs, supp.amp, 74.3) > 3 * envAt(supp.freqs, supp.amp, SP),
      `bastırmalı: BPFO ${envAt(supp.freqs, supp.amp, 74.3)} / 2fe ${envAt(supp.freqs, supp.amp, SP)}`);
  });

  test(`${file}: sürücü bastırması sürücüsüz rulman arızasını bozmuyor`, () => {
    const bF = { BPFO: 87.3, BPFI: 129.4, BSF: 57.1, FTF: 9.7 };
    const g = rng(22);
    const T = 1 / 87.3;
    const x = signal((t) => { const tau = t % T; return 0.05 * g() + 0.6 * Math.exp(-tau * 900) * Math.sin(2 * Math.PI * 2000 * tau); });
    const { freqs, amp } = api.envelopeSpectrum(x, FS, 1300, 2800, { driveFe: FE });
    const d = api.downsampleSpectrum(freqs, amp, 200, 0, api.ENV_SPEC_F_MAX, 'max');
    const r = api.bearingFaultIndex(d.f, d.v, bF, 24.4, 50, true);
    assert.equal(r.top, 'BPFO');
    assert.ok(r.value > 40, `BPFO skoru ${r.value}`);
  });

  test(`${file}: BPFO 3× devire çok yakınsa uyarı notu, sürücü çizgisi rulman sayılmıyor`, () => {
    const shaft = 24.01; // 6319: BPFO 3.0959× → 74.3 Hz, 3× devir 72.0 Hz
    const bF = { BPFO: 3.0959 * shaft, BPFI: 4.9041 * shaft, BSF: 2.0992 * shaft, FTF: 0.3870 * shaft };
    const g = rng(34);
    const x = signal((t) => 0.05 * g() + vfd(t) + sine(74.3, 0.15)(t) + sine(148.6, 0.1)(t) + sine(SP, 0.2)(t));
    const { freqs, psd } = api.computePSD(x, FS);
    const r = api.analyzeBearing(freqs, psd, null, bF, { rpm: shaft * 60, shaftHz: shaft });
    assert.ok(r.level >= 2);
    assert.ok(r.notes.some((n) => n.includes('3× devire')), r.notes.join(' | '));
    assert.ok(r.notes.some((n) => n.startsWith('Sürücü (VFD) izi')), 'sürücü notu');
  });

  test(`${file}: ham veri dosyası (WS3R) çözülüyor`, () => {
    const n = [3, 2, 1]; // Z, X, Y
    const buf = new ArrayBuffer(28 + 6 * 2);
    const dv = new DataView(buf);
    [0x57, 0x53, 0x33, 0x52].forEach((b, i) => dv.setUint8(i, b));
    dv.setUint16(4, 1, true); dv.setUint16(6, 3, true); dv.setUint32(8, 6510, true); dv.setFloat32(12, 0.5, true);
    n.forEach((v, i) => dv.setUint32(16 + i * 4, v, true));
    [10, -20, 30, 4, 6, -8].forEach((v, i) => dv.setInt16(28 + i * 2, v, true));
    const r = api.decodeRawBuffer(buf);
    assert.equal(r.fs, 6510);
    assert.deepEqual(Array.from(r.axes.Z), [5, -10, 15]);
    assert.deepEqual(Array.from(r.axes.X), [2, 3]);
    assert.deepEqual(Array.from(r.axes.Y), [-4]);
    assert.equal(api.decodeRawBuffer(new ArrayBuffer(10)), null);
  });

  test(`${file}: grafik çizgileri analizle aynı (ölçülen) devri kullanıyor`, () => {
    // 1400 rpm girildi, spektrumdan 24.01 Hz ölçüldü (%2.9 fark) → ölçülen kullanılır
    assert.equal(api.effectiveShaftHz(1400, 24.01), 24.01);
    // %6'dan fazla sapma → güvenilmez, nominal (null)
    assert.equal(api.effectiveShaftHz(1400, 26), null);
    assert.equal(api.effectiveShaftHz(1400, null), null);
    assert.equal(api.effectiveShaftHz(null, 24), null);
  });

  test(`${file}: TWF — crest factor / kurtosis gürültüde normal, darbede yüksek`, () => {
    const g = rng(31);
    const noise = signal(() => 0.01 * g());
    const n = api.computeTwfStats(noise, FS);
    assert.ok(n.hp.cf > 3 && n.hp.cf < 5, `gürültü CF ${n.hp.cf}`);
    assert.ok(Math.abs(n.hp.kurt - 3) < 0.3, `gürültü kurtosis ${n.hp.kurt}`);
    assert.equal(api.twfVerdict(n).level, 0);
    // 77 Hz'de tekrarlayan, 2.1 kHz'de sönen darbeler (dış bilezik) + büyük 1× (filtre bunu eler)
    const T = 1 / 77;
    const imp = signal((t) => 0.004 * g() + 0.5 * Math.sin(2 * Math.PI * 24.6 * t) + 0.08 * Math.exp(-(t % T) * 2500) * Math.sin(2 * Math.PI * 2100 * (t % T)));
    const s = api.computeTwfStats(imp, FS);
    assert.ok(s.hp.cf >= 6, `darbe CF ${s.hp.cf}`);
    assert.ok(s.hp.kurt >= 4.5, `darbe kurtosis ${s.hp.kurt}`);
    assert.ok(s.raw.cf < 2, `ham sinyalde 1× baskın, CF ${s.raw.cf}`);
    assert.equal(api.twfVerdict(s).level, 2);
    // sinüs: CF = √2
    const sn = api.computeTwfStats(signal(sine(50, 1)), FS);
    assert.ok(Math.abs(sn.raw.cf - Math.SQRT2) < 0.02, `sinüs CF ${sn.raw.cf}`);
  });

  test(`${file}: CF trendi — tepeden dönüş ve yükseliş`, () => {
    const p = (cf, rms) => ({ cf, rms, kurt: 3 });
    const f = api.evaluateCfTrend([p(4, 0.01), p(5.5, 0.012), p(6.5, 0.015), p(4.2, 0.04)]);
    assert.equal(f && f.kind, 'falling');
    const r = api.evaluateCfTrend([p(4, 0.01), p(4.1, 0.01), p(6.8, 0.012)]);
    assert.equal(r && r.kind, 'rising');
    assert.equal(api.evaluateCfTrend([p(4, 0.01), p(4.2, 0.011), p(4.1, 0.01)]), null);
    // CF düştü ama RMS artmadı → tepeden dönüş sayılmaz
    assert.equal(api.evaluateCfTrend([p(4, 0.01), p(6.5, 0.015), p(4.5, 0.015)]), null);
  });

  test(`${file}: ski-slope (oturma geçişi) yakalanıyor, sağlam ölçüm temiz`, () => {
    const g = rng(41);
    const ok = signal((t) => 0.01 * g() + sine(8.3, 0.2)(t) + sine(24.6, 0.3)(t));
    assert.equal(api.skiSlopeCheck(ok, FS), null, '500 rpm 1× + 1500 rpm sağlam');
    const ski = signal((t) => 0.01 * g() + sine(24.6, 0.05)(t) + 0.1 * Math.exp(-t / 0.35));
    const r = api.skiSlopeCheck(ski, FS);
    assert.ok(r, 'sönen kayma yakalanmalı');
    api.getAxisSamples().X = Float32Array.from(ski); api.getAxisSamples().Y = Float32Array.from(ok); api.getAxisSamples().Z = Float32Array.from(ok);
    const issues = api.assessSignalQuality();
    assert.ok(issues.some(q => q.startsWith('X: ski-slope')), issues.join(' | '));
    assert.ok(!issues.some(q => q.startsWith('Y:')), issues.join(' | '));
  });

  test(`${file}: 2×LF elektrik tepesi ayrılıyor, mil harmoniğiyle karışmıyor`, () => {
    const accFor = (f, v) => v / 1000 * 2 * Math.PI * f / G;
    const g = rng(51);
    const fr = 1480 / 60; // 4× = 98.67 Hz, 2×LF = 100 Hz
    const run = (comps) => {
      const x = signal((t) => 0.002 * g() + comps.reduce((s, [f, v]) => s + sine(f, accFor(f, v))(t), 0));
      const { freqs, psd } = api.computePSD(x, FS);
      const { velAmp, rmsVelocity } = api.velocitySpectrumFromAccelPSD(freqs, psd, 10, 1000);
      return api.electricalCheck(freqs, velAmp, 50, fr, rmsVelocity);
    };
    const e = run([[fr, 2], [100, 2]]);
    assert.equal(e && e.status, 'electrical');
    assert.ok(Math.abs(e.f - 100) < 0.5);
    assert.equal(run([[fr, 2], [4 * fr, 2]]), null, '4× devir tepesi elektrik sayılmamalı');
    assert.equal(run([[fr, 3]]), null, '2×LF yok');
    // 4 kutup, sıfıra yakın kayma: 2×LF ile 4× devir çözünürlükte ayrılamaz → belirsiz
    const fr0 = 24.95;
    const x = signal((t) => 0.002 * g() + sine(fr0, accFor(fr0, 2))(t) + sine(100, accFor(100, 2))(t));
    const sp = api.computePSD(x, FS);
    const vv = api.velocitySpectrumFromAccelPSD(sp.freqs, sp.psd, 10, 1000);
    assert.equal(api.electricalCheck(sp.freqs, vv.velAmp, 50, fr0, vv.rmsVelocity).status, 'ambiguous');
  });

  test(`${file}: devir altı — FTF, keskin tepe ve geniş tümsek ayrılıyor`, () => {
    const g = rng(61);
    const fr = 24.6, accFor = (f, v) => v / 1000 * 2 * Math.PI * f / G;
    const ovlOf = (x) => { const sp = api.computePSD(x, FS); return [sp, api.velocitySpectrumFromAccelPSD(sp.freqs, sp.psd, 10, 1000).rmsVelocity]; };
    const ftf = 0.3838 * fr;
    let [sp, ovl] = ovlOf(signal((t) => 0.002 * g() + sine(fr, accFor(fr, 2))(t) + sine(ftf, accFor(ftf, 1.5))(t)));
    assert.equal(api.subSyncCheck(sp.freqs, sp.psd, fr, ovl, ftf).kind, 'ftf');
    assert.equal(api.subSyncCheck(sp.freqs, sp.psd, fr, ovl, null).kind, 'narrow', 'rulman kodu yoksa keskin tepe');
    // dar bantlı gürültü (≈ 9–17 Hz) → geniş tümsek
    const h = new Float64Array(N); { const w = rng(62); let a = 0, b = 0; for(let i=0;i<N;i++){ const v = w(); a = 0.985*a + v; b = 0.9*b + a; h[i] = b; } }
    const hp = Float64Array.from(h, (v, i) => v - (i ? h[i-1] : 0));
    const sc = 0.02 / Math.sqrt(hp.reduce((s, v) => s + v*v, 0) / N);
    [sp, ovl] = ovlOf(signal((t, k) => 0.002 * g() + sine(fr, accFor(fr, 2))(t) + sc * hp[k]));
    const br = api.subSyncCheck(sp.freqs, sp.psd, fr, ovl, null);
    assert.ok(br && br.kind === 'broad', JSON.stringify(br));
    [sp, ovl] = ovlOf(signal((t) => 0.002 * g() + sine(fr, accFor(fr, 2))(t)));
    assert.equal(api.subSyncCheck(sp.freqs, sp.psd, fr, ovl, ftf), null, 'temiz');
  });

  test(`${file}: BPFI yan bantları (±1× devir) bulunuyor`, () => {
    const g = rng(71);
    const fr = 24.6, bpfi = 4.9292 * fr;
    const am = signal((t) => 0.003 * g() + 0.05 * (1 + 0.6 * Math.cos(2 * Math.PI * fr * t)) * Math.sin(2 * Math.PI * bpfi * t));
    const sp = api.computePSD(am, FS);
    const r = api.sidebandCheck(sp.freqs, sp.psd, bpfi, fr);
    assert.ok(r.center, 'merkez tepe');
    assert.equal(r.ones, 2, JSON.stringify(r.sidebands));
    const pure = api.computePSD(signal((t) => 0.003 * g() + 0.05 * Math.sin(2 * Math.PI * bpfi * t)), FS);
    assert.equal(api.sidebandCheck(pure.freqs, pure.psd, bpfi, fr).ones, 0, 'modülasyonsuz → yan bant yok');
  });

  test(`${file}: uyarılar için crest factor özeti ve trendi`, () => {
    const tw = (cf, rms) => ({ X: { raw: { rms: 0.1 }, hp: { cf, kurt: 3, rms } } });
    assert.deepEqual({ ...api.twfSummaryOf(tw(4.2, 0.01)).X }, { cf: 4.2, kurt: 3, rms: 0.01 });
    assert.equal(api.twfSummaryOf(null), null);
    const rec = [[4, 0.01], [5.6, 0.012], [6.4, 0.015], [4.1, 0.04]].map(([c, r]) => ({ cf: api.twfSummaryOf(tw(c, r)) }));
    const t = api.evaluateImpactTrend(rec);
    assert.equal(t.ax, 'X'); assert.equal(t.kind, 'falling');
    assert.equal(api.evaluateImpactTrend([{ velRMS: {} }, { cf: null }]), null, 'eski özetlerde cf yok');
  });

  test(`${file}: hız spektrumu tepesi gerçek RMS'i gösteriyor, kayıt ve eski kayıt tepeyi koruyor`, () => {
    for (const fr of [24.6, 49.5, 8.33]) {
      const accAmp = 22 * Math.SQRT2 / 1000 * 2 * Math.PI * fr / G;
      const x = signal(sine(fr, accAmp));
      const sp = api.computePSD(x, FS);
      const fLow = fr < 10 ? 5.8 : 10;
      const { velAmp, rmsVelocity } = api.velocitySpectrumFromAccelPSD(sp.freqs, sp.psd, fLow, 1000);
      assert.ok(Math.abs(rmsVelocity - 22) < 0.3);
      const line = api.velLineSpectrum(velAmp);
      const pk = Math.max(...line);
      assert.ok(Math.abs(pk - 22) < 0.8, `${fr} Hz tepe ${pk}`);
      // Kayıt: 300 noktaya 'max' ile indirgenince tepe korunur
      const ds = api.downsampleSpectrum(sp.freqs, line, 300, fLow, 1000, 'max');
      assert.ok(Math.abs(Math.max(...ds.v) - pk) < 0.01);
      // Eski kayıt (velSpectrum ortalamayla indirgenmiş): PSD'den yeniden üretilir
      const oldDoc = { velSpectrum: { X: api.downsampleSpectrum(sp.freqs, velAmp, 300, fLow, 1000) },
                       accelPSD: { X: api.downsampleSpectrum(sp.freqs, sp.psd, 640, 0, FS / 2, 'max') }, velBandLow: fLow, sampleRate: FS };
      assert.ok(Math.max(...oldDoc.velSpectrum.X.v) < 8, 'eski kayıt hatalı küçük');
      api.fixDocVelSpectrum(oldDoc);
      const fixed = Math.max(...oldDoc.velSpectrum.X.v);
      assert.ok(fixed > 17.5 && fixed < 23, `${fr} Hz düzeltilmiş eski kayıt tepe ${fixed}`);
    }
    const newDoc = { velSpecMode: api.VEL_SPEC_MODE, velSpectrum: { X: { f: [1], v: [5] } }, accelPSD: { X: { f: [1], v: [1] } } };
    assert.equal(api.fixDocVelSpectrum(newDoc).velSpectrum.X.v[0], 5, 'yeni kayda dokunulmaz');
  });

  test(`${file}: halı tipi taban (yağ filmi) — şekil ve trend ölçütü`, () => {
    const g = rng(81);
    // sağlam: 1× + düz sensör gürültüsü → halı yok
    const ok = signal((t) => 0.3 * Math.sin(2 * Math.PI * 24.6 * t) + 0.01 * g());
    let sp = api.computePSD(ok, FS);
    assert.equal(api.carpetCheck(sp.freqs, sp.psd, FS, 1.1), null);
    // yağsız: 1–3 kHz'de geniş bant gürültü (rezonanslı filtrelenmiş gürültü) → halı
    const hpN = api.highpassFiltFilt(Float64Array.from({ length: N }, () => g()), FS, 1000);
    const bad = signal((t, k) => 0.3 * Math.sin(2 * Math.PI * 24.6 * t) + 0.003 * g() + 0.2 * hpN[k]);
    sp = api.computePSD(bad, FS);
    const c = api.carpetCheck(sp.freqs, sp.psd, FS, null);
    assert.ok(c && c.byShape, JSON.stringify(c));
    // trend: şekil yok ama ilk ölçümlere göre 2.5 kat
    const t = api.carpetCheck(null, null, FS, 2.5);
    assert.ok(t && t.byTrend && !t.byShape);
    assert.equal(api.carpetCheck(null, null, FS, 1.4), null);
  });

  test(`${file}: sürücü taşıyıcı tarağı halı sanılmıyor`, () => {
    const g = rng(91);
    const fe = 48.33, sp = 2 * fe, fc = 2097.8;
    // taşıyıcı ve 2·fe aralıklı yan çizgiler + biraz geniş bant + 1×
    const amps = { 0: 0.9, 1: 0.45, '-1': 0.3, 2: 0.2, '-2': 0.15, 3: 0.1, '-3': 0.08 };
    const x = signal((t) => 0.3 * Math.sin(2 * Math.PI * 24.1 * t) + 0.004 * g() +
      Object.entries(amps).reduce((a, [k, A]) => a + A * Math.sin(2 * Math.PI * (fc + Number(k) * sp) * t + Number(k)), 0));
    const ps = api.computePSD(x, FS);
    const v = api.vfdCarrierCheck(ps.freqs, ps.psd, fe, 1000, 3000);
    assert.ok(v && v.dominant, JSON.stringify(v && { share: v.share, lines: v.lines }));
    assert.ok(Math.abs(v.fc - fc) < 1);
    // trend ölçütü sürücü baskınken kullanılmaz; çizgiler çıkarılınca taban normal → halı yok
    assert.equal(api.carpetCheck(ps.freqs, ps.psd, FS, 3.0, v), null);
    // sürücü bilgisi yoksa (fe yok) kontrol yapılmaz
    assert.equal(api.vfdCarrierCheck(ps.freqs, ps.psd, null), null);
    // gerçek halı (geniş bant gürültü, tarak yok) → baskın değil
    const hpN = api.highpassFiltFilt(Float64Array.from({ length: N }, () => g()), FS, 1000);
    const bad = signal((t, k) => 0.3 * Math.sin(2 * Math.PI * 24.1 * t) + 0.003 * g() + 0.2 * hpN[k]);
    const pb = api.computePSD(bad, FS);
    const vb = api.vfdCarrierCheck(pb.freqs, pb.psd, fe, 1000, 3000);
    assert.ok(!vb.dominant, JSON.stringify({ share: vb.share, lines: vb.lines }));
    const cb = api.carpetCheck(pb.freqs, pb.psd, FS, null, vb);
    assert.ok(cb && cb.byShape && !cb.vfd);
  });
}
