# Chaos ADBrowser

**Ein kompletter Browser als Website — mit eingebautem Adblocker.**

Man öffnet die Seite, tippt oben eine Adresse ein und bekommt die Zielwebsite *gereinigt* geliefert:
keine Werbebanners, keine Tracker, keine Popunder, kein Cookie-Banner. Läuft auf Port **6001**,
ausgeliefert als **Docker-Container**, funktioniert auf jedem Gerät (Handy, Firmen-PC, Konsole,
Smart-TV-Browser) und braucht dort **keine Installation und keine Erweiterung**.

```bash
docker compose up -d          # startet auf http://localhost:6001
# oder ohne Docker:
npm install && npm start      # dasselbe, Port 6001
```

Dann `http://localhost:6001` öffnen → YouTube, Spiegel, Wikipedia, was auch immer eingeben → lossurfen.
Für den ersten Blick ohne Internet: auf der Startseite ist ein Link auf die **AD-Testseite**
(`/site/news.html`) — eine absichtlich zugekleisterte Demo-Seite, an der man sieht, was wegfiltert wird.

---

## Wie es funktioniert

Es ist ein **Forward-Proxy im Browser**, keine Extension. Der einzige Weg, Werbung wegzubekommen,
ohne dass man auf jedem Gerät etwas installieren kann, ist: die Requests laufen durch *uns* hindurch,
und wir entscheiden, bevor das erste Byte den Nutzer erreicht.

```
 iframe (Tab)                     Chaos ADBrowser (Node, Port 6001)               Internet
 ┌────────────────┐   GET /b/<sid>/p/<enc(origin)>/pfad   ┌──────────────────────┐
 │ die echte Seite │ ────────────────────────────────────▶ │ 1. Filter-Engine     │
 │ iframe.src =    │                                        │    Aho-Corasick +  │
 │ /b/…/p/…        │ ◀────────────────────────────────────  │    Suffix-Hosts    │
 │ + unser Runtime-│   HTML/CSS: umgeschrieben, Header      │ 2. undici → Ziel     │
 │   script rein   │   bereinigt, Bootstrap injectiert      │ 3. Objekt-Cache      │
 └────────────────┘                                        └──────────────────────┘
```

**URL-Schema.** Proxied Dokument und alle seine Sub-Resources:

```
/b/<sessionId>/p/<base64url(origin)>/<originaler Pfad>?<query>#<frag>
/b/<sessionId>/w/<base64url(origin)>/<pfad>?<query>      (WebSocket)
```

Nur der *Origin* ist kodiert, Pfad/Query/Fragment bleiben im Klartext. Das ist der Trick, der das
ganze schnell **und** robust macht: Der Browser relativiert `img.png` oder `../x.css` gegen die
iframe-URL — und landet wegen unserer Präfix-Struktur automatisch wieder im Proxy. Es braucht also
für relative URLs *gar keine* Umschreibung. Nur absolute und wurzelrelative (`/x`) werden angefasst,
serverseitig im HTML/CSS und clientseitig zur Laufzeit.

**Was der Handler macht** (`src/proxy/handler.js`)

| Thema | Verhalten |
|---|---|
| HTML/CSS | gepuffert & umgeschrieben (≤ `CHAOS_MAX_REWRITE_MB`, Default 16 MB), `X-Frame-Options`, CSP, HSTS, `Refresh`, SRI/`integrity`, `crossorigin` raus |
| alles andere | **byte-genau durchgeleitet** (Bilder, Fonts, JS, Media) — kein Parsen, kein Re-Komprimieren |
| Redirects | serverseitig **nie** gefolgt; 302/307 auf die proxied Ziel-URL (Set-Cookie vorher eingesammelt) |
| Cookies | liegen in einer Session-Jar auf dem Server; `HttpOnly`-Cookies sieht die Seite nie |
| `Sec-Fetch-*`, UA, Referer | werden passend zum Ziel umgeschrieben; `Accept-Encoding: gzip,deflate,br` rein, Kompression bleibt erhalten |
| Range / 304 / HEAD | durchgereicht → Video-Suchen und Re-Validieren funktionieren wie üblich |
| SSRF-Schutz | loopback/RFC1918/link-local wird nicht angefasst (Ausnahme: `/site/*`, damit die Demo offline läuft) |

**Was das Runtime-Script macht** (`src/inject/client.js`, läuft in jedem proxied Dokument *vor* dem
Seiten-JS): `fetch`/XHR/Beacons/WebSockets/`EventSource`/`form.action`/`srcdoc`/`document.write`
werden so verpackt, dass sie im Proxy bleiben; `location`, `a.href`, `getAttribute('src')` … geben
die *echte* URL zurück, damit die Seite nichts merkt. Dazu: Storage-Isolation pro echtem Host
(`localStorage`, `sessionStorage`, IndexedDB, Cache API), Service-Worker deaktiviert, Popup-Fenster
werden neue Tabs, Titel/URL an die Chrome gemeldet, und für YouTube: Ad-Placements aus der
Player-Response rasieren + „Werbung überspringen" automatisch klicken.

**Der Adblocker** (`src/adblock/`) ist ein eigener Engine-Kern, kein `adblock-rs`:

1. **Prefilter**: Aho-Corasick-Automat über ~4 200 Anker-Strings (Pfadbrocken aus den Regeln) +
   `hostBucket`/`pageBucket` (Reversed-Suffix-Host → Regel-Ids), dazu ~5 1 000 Hosts als Set-Lookup.
2. **Entscheidung** = $-Optionen (Typ, third-party, $domain, Ausnahmen) auf den wenigen Kandidaten.
3. **Cosmetic Filtering**: vorgefertigte CSS pro Host wird *in den `<head>` des Dokuments injiziert*
   (vor dem Runtime-Script), damit es nie flackert. `:has()` bleibt, `:upward()`/`:has-text()` nicht.
4. **Decision-Cache** (key = url+typ+third-party+seite), 60 000 Einträge, Voll-Treffer & Voll-Fehlschüsse.

Kompiliert wird offline (`npm run build:filters`) aus EasyList, EasyPrivacy, Fanboy's Annoyance/Social
und einer eigenen Seed-Liste: **51 544 blockierte Hosts, 9 025 Netzwerk-Regeln, 9 000+ Cosmetic-Selektoren,
930 KB gz** — geladen in ~20 ms. `data/seed.txt` wird *immer* zusätzlich gemerged, damit auch ohne
Internet eine saubere Grundliste aktiv ist.

## Performance

Gemessen mit `npm run bench` (Node 22, eine CPU-Session, 200 000 Mischrequests):

| Messung | Ergebnis |
|---|---|
| `engine.match` (warm, Decision-Cache) | **~950 000 Checks/s** (1,1 µs) |
| `engine.match` (kalt, Cache aus) | ~148 000 Checks/s (6,8 µs) |
| `cosmeticCss(host)` | 0,3 µs (gecacht pro Host) |
| HTML-Rewrite 33 KB | ~40 µs → **~800 MB/s** |
| Boot → `/healthz` bereit | **~0,3 s** (inkl. 930 KB Payload) |
| 400 Dokumente über den Proxy, 8 parallel | ~500 Dok/s, ~2 ms over head/dok |

Warum es sich trotzdem *schneller* anfühlt als ein normaler Browser mit Erweiterung: die Werbung wird
nie angefragt. Auf einer typischen Nachrichtenseite fallen damit 40–70 Requests und oft mehrere MB
komplett weg — das ist der größte Hebel, und er wirkt vor dem ersten Byte, nicht danach.

Die wichtigsten Stellschrauben: undici-Keep-Alive-Pool mit 24 Verbindungen pro Origin, Streaming für
alles, was nicht umgeschrieben werden muss, Objekt-Cache (`ua|typ|url`, 192 MB) für Assets,
`no-cache` nur für Dokumente, Brotli/q6 für die eigene UI, und `Cache-Control: immutable` für
Runtime-Assets.

## Konfiguration

Alles über Umgebungsvariablen, keine Datei nötig:

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `6001` | Port (Pflicht laut Anforderung :)) |
| `CHAOS_HOST` | `0.0.0.0` | Bind-Adresse |
| `CHAOS_ACCESS_CODE` | – | **Setzen!** Ohne Code ist der Proxy offen für alle, die den Port erreichen |
| `CHAOS_PUBLIC_BASE` | – | `https://browser.example.com` hinter Reverse-Proxys |
| `CHAOS_ISOLATE_SUFFIX` | – | `tabs.example.com` → jeder Tab auf eigenem Origin (Wildcard-DNS + TLS nötig) |
| `CHAOS_ISOLATE_TLS` | `1` | `0` = http für die isolierten Origins (nur LAN/Test) |
| `CHAOS_ADBLOCK` | `1` | Filter-Engine globally an/aus |
| `CHAOS_COSMETIC` | `1` | Element-Ausblendungen injizieren |
| `CHAOS_ENHANCED_COSMETIC` | `1` | `$important` + Extra-Regeln (YouTube & Co.) |
| `CHAOS_BLOCK_AD_DOCS` | `0` | auch Werbe-*Navigationen* (Popunder) blockieren |
| `CHAOS_FILTERS_AUTO_UPDATE` | `0` | alle `CHAOS_FILTERS_UPDATE_HOURS` (24) neu bauen |
| `CHAOS_ALLOW_HOSTS` / `CHAOS_DENY_HOSTS` | – | Kommagetrennte erlaubte/verbotene Ziel-Hosts |
| `CHAOS_SSRF_GUARD` | `1` | keine privaten/loopback Adressen anfassen |
| `CHAOS_ALLOW_PRIVATE` | `0` | für Tests/interne Seiten einschalten |
| `CHAOS_MAX_TABS` | `24` | Tabs pro Profil, dann wird das älteste gekappt |
| `CHAOS_MAX_PROFILES` | `5000` | lebende Profile (Cookie-Jar + Verlauf) insgesamt |
| `CHAOS_SESSION_TTL_MIN` | `720` | Profil-Alter in Minuten |
| `CHAOS_CACHE_MB` / `CHAOS_CACHE_TTL_MS` | `192` / `300000` | Objekt-Cache |
| `CHAOS_CONNECTIONS_PER_ORIGIN` | `24` | Upstream-Poolgröße |
| `CHAOS_MAX_REWRITE_MB` | `16` | größer → HTML wird ungearbeitet durchgereicht |
| `CHAOS_UA_DESKTOP` / `CHAOS_UA_MOBILE` | Chrome 131 / iOS-Safari | User-Agent der Seiten |
| `CHAOS_SEARCH` | DuckDuckGo | wenn die Adresszeile eine Frage statt URL ist |
| `CHAOS_STRIP_QUERY` | – | z.B. `utm_source,utm_medium,gclid` |
| `CHAOS_LOG_LEVEL` | `info` | `debug` für jede Request-Entscheidung |

## Was geht — und was nicht

Geht gut: normale Nachrichtenseiten, Blogs, Docs, Shops, Wikipedia, Reddit, GitHub, Videos *ohne*
DRM (ARD-Mediathek läuft, Netflix nicht), YouTube-Werbung im Player (Ad-Placements werden aus der
Player-Response entfernt, Skip wird geklickt), Formulare, Login (Cookies liegen in der Jar pro Tab),
History, Back/Forward, Downloads, Range-Requests, WebSocket-Apps.

Geht **nicht**, und das ist physikalisch/technisch, kein Bug:

* **Google-/YouTube-Login**: Google prüft den Origin von Cookies und CAPTCHAs; über einen Proxy
  funktioniert das regelmäßig nicht. Für YouTube-Kommentare/etc. eingeloggt bleiben → andere Lösung.
* **hCaptcha/reCAPTCHA/Turnstile**: löst nicht (IP + Origin passen nicht).
* **DRM (Widevine/FairPlay)**: Media Keys sind an das Gerät gebunden — Netflix/Spotify/Disney+
  bleiben zu. Freie Videos (MP4/HLS ohne Verschlüsselung) laufen.
* **Seiten, die auf `document.domain`/postMessage-Origin-Checks pochen** oder ihr own
  Service-Worker-App-Shell sein wollen (Service Worker sind im Proxy absichtlich aus).
* `file:`/`ftp:`/`chrome://` gibt es nicht — nur http(s).

## Sicherheit (bitte lesen)

Ein Proxy, der fremde Inhalte ausliefert, ist ein **offener Relay**. Standard-Absicherung:

1. **`CHAOS_ACCESS_CODE` setzen** — sonst kann jeder im Netz den Rechner als Proxy missbrauchen.
2. **TLS davor** (Caddy/nginx/Traefik). Der Container spricht http auf 6001.
3. Container ist read-only, `cap_drop: ALL`, kein root, `mem_limit` (siehe `docker-compose.yml`).
4. `CHAOS_DENY_HOSTS` oder `CHAOS_ALLOW_HOSTS`, falls nur bestimmte Seiten erreichbar sein sollen.
5. `CHAOS_ISOLATE_SUFFIX` verwenden, wenn mehrere Nutzer: dann bekommt jeder Tab einen **eigenen
   Origin** und die proxied Seite kann die UI (und deren Storage) nicht mehr anfassen. Ohne Isolation
   laufen UI und Seiten auf demselben Origin — die Sandbox der iframes verhindert Top-Level-Navigation
   und Frame-Busting, aber ein hart getrenntes Sandboxed-Origin ist besser.

Die Seiten *sehen* unsere Server-IP, nicht deine. Cookies/Passwörter liegen im Speicher des
Containers (Session-TTL 12 h) — wer root auf dem Container hat, liest sie. Nicht für Banking nutzen.

## API (für Automatisierung)

```
GET  /healthz                    {"ok":true,"uptime":…}
GET  /metrics                    Cache/Engine/Heap als JSON
POST /api/tab        {url}       → {id,url,proxied,prefix}   neuer Tab (leer = about:blank)
POST /api/tab/close  {id}
GET  /api/state                   Profil, Einstellungen, Engine-Zähler, Top-Hosts
POST /api/settings  {…}           images/media/adblock/cosmetic/enhanced/scripts/websockets/…
POST /api/user-rules {rules}      eigene Regeln im ABP-Format (persist in data/user-rules.txt)
GET  /api/resolve    ?q=…         Adresszeile → Ziel-URL oder Suche
POST /api/clear     {what}        history|cookies|cache|stats
POST /api/filters/update          Listen neu bauen (nur mit CHAOS_ALLOW_FILTER_UPDATE=1)
GET  /b/<sid>/api/tab             Live-Stats eines Tabs (blocked, savedBytes, top hosts)
POST /b/<sid>/api/cookies         {name:value} → Session-Jar (vom Runtime-Script benutzt)
```

## Demoseite / Selbsttest

`/site/news.html` (Werbebanner, Consent-Overlay, 3 externe Ad-Skripte, Ad-Iframes, Formular mit
Cookie-Roundtrip), `/site/video.html` (Fake-Player mit Pre-Roll + Skip-Button), `/site/selftest.html`
(behauptet pro Zeile, was der Proxy tut — URL-Täuschung, Storage-Isolation, Block-Stubs, Cosmetic).
Alles davon läuft **ohne Internet**, weil der SSRF-Guard `/site/*` auf dem eigenen Host erlaubt.

## Tests & Werkzeuge

```bash
npm test          # 53 Tests: Engine, Encoder, Cookies, Store, Rewriting, kompletter Proxy-e2e inkl. WebSocket-Tunnel
npm run bench     # Zahlen von oben
npm run build:filters            # Listen neu kompilieren (braucht Netz)
npm run build:filters -- --offline   # nur data/lists/*.txt + seed.txt
```

Der e2e-Test startet selbst einen Server auf einem freien Port, schreibt nach `CHAOS_DATA_DIR` im
tmp-Verzeichnis und prüft echte Antworten (Bootstrap-Injektion, Block-Stubs, Redirect, POST-Body,
Cookie-Jar, Settings, SSRF, WS-Tunnel, Brotli, 304).

## Projektlayout

```
src/server.js            HTTP-Router, UI-Routen, /api/*, statisches Ausliefern, Bootstrap
src/proxy/handler.js     der eigentliche Proxy (Policy → Fetch → Rewrite → Stream)
src/proxy/{fetcher,html,css,cache,responses}.js
src/proxy/ws.js          WebSocket-Tunnel (Raw-Byte-Pipe, kein Frame-Parsing)
src/adblock/{engine,aho,compile}.js
src/inject/bootstrap.js  <head>-Payload (State + CSS + Runtime)
src/inject/client.js     Runtime in jeder Seite
src/sessions.js          Profile, Tabs, Jar, Historie, Stats
src/cookies.js src/encode.js src/config.js src/util.js
src/ui/{index.html,app.css,app.js,start.html}   Browser-Chrome (Tabs, Omnibox, Panel)
src/site/*               Demo-/Selbsttest-Seiten
scripts/build-filters.mjs  → data/adblock.json.gz
test/*.test.mjs test/bench.mjs
```

Kein Build-Schritt, nur zwei Abhängigkeiten: `undici` (HTTP-Client) und `ws` (Upgrade-Handling für
die Demo-Echo-Strecke). ~7 000 Zeilen, alles ES-Module.
