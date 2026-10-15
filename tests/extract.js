// Uygulama tek bir HTML dosyası olduğu için hesap fonksiyonlarını test etmenin
// en az müdahaleli yolu: index.html'in kaynağından fonksiyon/sabit tanımlarını
// metin olarak çıkarıp ayrı bir Node vm bağlamında çalıştırmak. Uygulama koduna
// test için hiçbir değişiklik gerekmez.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Her iki sürüm aynı hesap kodunu taşır; testler ikisinde de koşar.
const APP_FILES = ['index.html', 'pocketbase/pb_public/index.html'];

// `start` konumundaki tanımın bittiği yeri bulur: dize/şablon/yorum içindeki
// parantezleri saymadan, en dış düzeyde kapanan `}` (fonksiyon) ya da `;` (sabit).
function scanEnd(src, start, mode){
  let depth = 0, i = start;
  const tpl = []; // açık şablon dizelerindeki ${ } derinlikleri
  while(i < src.length){
    const c = src[i], d = src[i+1];
    if(c === '/' && d === '/'){ i = src.indexOf('\n', i); if(i < 0) return src.length; continue; }
    if(c === '/' && d === '*'){ i = src.indexOf('*/', i) + 2; continue; }
    // Düzenli ifade (ör. /'/g): öncesindeki anlamlı karakter bir işleç/ayraçsa bölme değildir.
    if(c === '/'){
      let j = i - 1; while(j >= 0 && /\s/.test(src[j])) j--;
      if(j < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(src[j])){
        i++;
        let cls = false;
        while(cls || src[i] !== '/'){
          if(src[i] === '\\') i++;
          else if(src[i] === '[') cls = true;
          else if(src[i] === ']') cls = false;
          i++;
        }
        i++; continue;
      }
    }
    if(c === '"' || c === "'"){
      i++;
      while(src[i] !== c){ if(src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if(c === '`' || (c === '}' && tpl.length && tpl[tpl.length-1] === depth)){
      if(c === '}') tpl.pop();
      i++;
      while(src[i] !== '`'){
        if(src[i] === '\\'){ i += 2; continue; }
        if(src[i] === '$' && src[i+1] === '{'){ tpl.push(depth); i += 2; break; }
        i++;
      }
      if(src[i] === '`') i++;
      continue;
    }
    if(c === '{' || c === '(' || c === '[') depth++;
    else if(c === '}' || c === ')' || c === ']'){
      depth--;
      if(mode === 'function' && depth === 0 && c === '}') return i + 1;
    } else if(mode === 'const' && c === ';' && depth === 0) return i + 1;
    i++;
  }
  throw new Error('Tanım sonu bulunamadı');
}

function definition(src, name){
  const fn = new RegExp('^(async )?function ' + name + '\\(', 'm').exec(src);
  if(fn) return src.slice(fn.index, scanEnd(src, fn.index, 'function'));
  const cn = new RegExp('^(const|let) ' + name + '\\b', 'm').exec(src);
  if(cn) return src.slice(cn.index, scanEnd(src, cn.index, 'const'));
  throw new Error(name + ' tanımı bulunamadı');
}

// İki işaret arasındaki bölgeyi olduğu gibi alır (çok sayıda sabit + fonksiyon içeren
// rulman analizi bölümü gibi). `endName` verilen fonksiyonun sonuna kadar uzanır.
function region(src, startMarker, endName){
  const s = src.indexOf(startMarker);
  if(s < 0) throw new Error(startMarker + ' bulunamadı');
  const fn = new RegExp('^function ' + endName + '\\(', 'm');
  const m = fn.exec(src.slice(s));
  if(!m) throw new Error(endName + ' bulunamadı');
  return src.slice(s, scanEnd(src, s + m.index, 'function'));
}

// names: fonksiyon/sabit adları; regions: [başlangıç işareti, son fonksiyon];
// globals: test bağlamına verilecek ek değişkenler; prelude: başa eklenen kod;
// exports: prelude'da tanımlanıp dışarı verilecek adlar.
function load(file, { names = [], regions = [], globals = {}, prelude = '', exports = [] } = {}){
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = [prelude]
    .concat(names.map(n => definition(src, n)))
    .concat(regions.map(([a, b]) => region(src, a, b)))
    .join('\n');
  const exported = names.concat(['analyzeBearing'], exports).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
  const ctx = vm.createContext({ Math, Number, Array, Object, Map, Set, String, Error, JSON,
    Float32Array, Float64Array, Int32Array, Uint8Array, DataView, ArrayBuffer, console, ...globals });
  vm.runInContext(code + '\nthis.__api = {' +
    exported.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(',') + '};', ctx);
  return ctx.__api;
}

module.exports = { APP_FILES, load };
