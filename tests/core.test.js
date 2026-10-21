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
    exports: ['getAxisSamples', 'shaftFaultBreakdown', 'estimateMainsBase', 'bearingFaultIndex', 'axisRoleOf', 'axialMisalignmentCheck'],
    names: ['parseSensorSampleRate', 'nextPow2', 'fft', 'ifft', 'computePSD', 'envelopeSpectrum',
      'velocitySpectrumFromAccelPSD', 'rmsAccelFromPSD', 'downsampleSpectrum',
      'ISO_ZONES', 'isoClass', 'isoEvaluate', 'ISO_BASIS_TEXT', 'isoLowSpeedNote',
      'escapeHtml', 'findSeqGaps', 'ENV_SPEC_F_MAX',
      'Q_CLIP_LSB', 'Q_CLIP_MIN_COUNT', 'Q_FLAT_STD_LSB', 'Q_STUCK_RUN', 'Q_SPIKE_LSB', 'Q_LEN_MISMATCH',
      'assessSignalQuality'],
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

  test(`${file}: ISO sınıfı ve bölge sınırları`, () => {
    assert.equal(api.isoClass(11, 'rijit'), 'I');
    assert.equal(api.isoClass(55, 'rijit'), 'II');
    assert.equal(api.isoClass(110, 'rijit'), 'III');
    assert.equal(api.isoClass(110, 'esnek'), 'IV');
    assert.equal(api.isoClass(null), null);
    assert.equal(api.isoEvaluate(1.12, 'II').zone, 'A', 'sınır dahil');
    assert.equal(api.isoEvaluate(1.13, 'II').zone, 'B');
    assert.equal(api.isoEvaluate(7.1, 'II').zone, 'C');
    assert.equal(api.isoEvaluate(7.2, 'II').zone, 'D');
    assert.equal(api.isoEvaluate(3, null), null);
  });

  test(`${file}: 600 rpm altında bant uyarısı, üstünde değil`, () => {
    assert.match(api.isoLowSpeedNote('450'), /600 rpm altı/);
    assert.equal(api.isoLowSpeedNote('1449'), '');
    assert.equal(api.isoLowSpeedNote('—'), '');
    assert.match(api.ISO_BASIS_TEXT, /10816-1/);
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
}
