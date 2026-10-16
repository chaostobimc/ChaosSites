# ChaosSites

Sammlung selbst gehosteter Mini-Web-Apps. Jede hat ihr eigenes Verzeichnis, eigene Doku und läuft
als eigener Docker-Container.

## Chaos ADBrowser

[→ `adbrowser/`](adbrowser/README.md) — **ein kompletter Browser als Website, mit eingebautem
Adblocker.** Adresse eintippen, die Seite kommt gereinigt zurück: keine Werbung, keine Tracker, keine
Popunder, kein Cookie-Banner. Funktioniert auf jedem Gerät ohne Installation und ohne Erweiterung.

```bash
cd adbrowser
docker compose up -d      # http://localhost:6001
```

* Proxy-Browser: `iframe` + Server-Side-Rewriting + eigene Session-Jar pro Tab
* eigener Adblocker-Kern: Aho-Corasick-Prefilter, 51 544 Hosts, 9 025 Regeln, 930 KB Payload,
  ~950 000 Entscheidungen/s, Cosmetic-CSS vor dem ersten Byte
* YouTube-Ad-Scrubbing + Auto-Skip, WebSocket-Tunnel, Range/304/Downloads, Demo-Seiten ohne Netz
* Node 22, keine Build-Step, 2 Dependencies, read-only Container, `npm test` = 53 Tests
