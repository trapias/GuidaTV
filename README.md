# Guida TV

Guida TV dei canali italiani, in locale. Raggiungibile da LAN e Tailscale.

- **epg**: immagine `ghcr.io/iptv-org/epg` — scarica i palinsesti (Rai, Mediaset, Sky, Superguida) e genera `guide.xml` (XMLTV). Aggiornamento all'avvio e alle 04:00 e 14:00.
- **web**: Node (senza framework) — legge l'XMLTV, lo tiene in memoria, espone `/api/*` e serve la SPA (vanilla JS, nessuna build). Conserva l'ultima guida valida in un volume.

## Uso
```
docker compose up -d --build
```
- LAN: `http://<ip-server>:8085`
- Tailscale: `http://<nome-host-tailscale>:8085`
- Stato: `http://<host>:8085/api/health`

Su telefono: "Aggiungi a schermata Home" per averla come app.

## Canali
`epg/channels.xml` è generato da `node epg/build-channels.mjs` (unisce le sorgenti iptv-org senza doppioni;
priorità Rai > Mediaset > Sky > Superguida). Modifica lo script (EXCLUDE/ALIAS) e rigenera, poi `docker compose restart epg`.
I canali senza dati non compaiono nell'app.

`epg/superguidatv.it.config.js` sostituisce lo scraper upstream, rotto dopo la riscrittura del sito.

## Sviluppo
`cd server && npm install && npm test`
