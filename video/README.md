# WS300 Video (Remotion)

Uygulamadan bağımsız Remotion projesi. Kök dizindeki PWA ve testleri etkilemez.

```bash
cd video
npm install
npm run studio   # tarayıcıda önizleme/düzenleme
npm run render   # out/intro.mp4
npm run still    # out/intro.png
```

Remotion ilk çalıştırmada kendi Chrome Headless Shell'ini indirir. İndirme engelliyse
mevcut bir Chromium gösterin: `--browser-executable=/path/to/chromium`.

Kompozisyonlar `src/Root.tsx` içinde tanımlanır; `Intro` örnek sahnedir (`src/Intro.tsx`).
