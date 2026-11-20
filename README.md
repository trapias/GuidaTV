# Guida TV

Guida TV dei canali italiani, in locale. Raggiungibile da LAN e Tailscale.

- **epg**: basato su `ghcr.io/iptv-org/epg` — scarica i palinsesti (Rai, Mediaset, Sky, Superguida) e genera `guide.xml` (XMLTV). Aggiornamento all'avvio e alle 04:00 e 14:00.
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

L'app usa i loghi dei canali presenti in `guide.xml` e, se mancano, gli URL in `server/src/logos.json` (iptv-org, Sky, Tivùsat, SuperGuida TV e RaiPlay).

In **Cinema**, **Serie TV** e **News** la guida mostra i programmi corrispondenti di tutti i canali. **Adesso** mostra quelli in onda, **Griglia** quelli del giorno selezionato. La copertura dipende dai metadati delle emittenti e dai titoli riconoscibili dei telegiornali.

`epg/superguidatv.it.config.js` sostituisce lo scraper upstream, rotto dopo la riscrittura del sito.

## Numero di canale (LCN) e visione in diretta
- Il numero del digitale terrestre compare accanto al canale e determina l'ordine. Predefiniti in `server/src/lcn.json`
  (numeri nazionali: possono differire per regione); per correggerli metti un `lcn.json` nel volume dati (`/data/lcn.json`, stesse chiavi).
- Il pulsante ▶ compare solo per i canali con uno stream. Gli stream si danno al server con una playlist M3U
  (`/data/streams.m3u`, oppure `STREAMS_M3U=<url o file>` nel compose; ricaricata ogni ~6 h). Le voci sono associate ai canali
  per `tvg-id`/nome; a parità vince la prima. Il compose usa `streams/official.m3u`: solo stream ufficiali in chiaro
  (Mediaset, TV2000, Warner Bros. Discovery). Rai e La7 sono esclusi (i server rifiutano i player generici).
  Le voci con `mux="1"` (Mediaset: audio e video su tracce HLS separate, che VLC desincronizza) passano da `ffmpeg -c copy`
  nel container (`/api/live/<id>.ts`, max `MAX_MUX`=4 contemporanei). Mediaset è geo-limitato all'Italia.
- Il player è per-dispositivo (⚙ in alto): **.m3u** (il browser scarica un file che il sistema apre con VLC, funziona ovunque),
  **schema URL** (`vlc://{url}`, utile su iOS/Android) o **copia indirizzo**.

## Registrazioni

Dalla scheda di un programma su un canale con stream diretto, **Registra** pianifica la cattura sul server. In **Registrazioni** si vedono gli stati e si possono annullare le prenotazioni future. Il margine predefinito è di 2 minuti prima e 10 dopo, modificabile con `RECORDINGS_BEFORE_MIN` e `RECORDINGS_AFTER_MIN` nell'ambiente del servizio web.

Il servizio cattura in MPEG-TS in `/data/recordings`. A registrazione conclusa, racchiude audio e video in un file MP4 senza ricodificarli e trasferisce il file via SMB a `//nas.local/TV`. Se il NAS è irraggiungibile, i file restano in locale e il trasferimento viene ritentato.

Compose legge le credenziali da `~/.config/guidatv/smb.credentials` (permessi `600`), con le righe `username=nome_utente` e `password=…`. L'utente SMB deve poter creare e rinominare i file nella condivisione. `GUIDATV_SMB_DIR`, `GUIDATV_SMB_SHARE` e `GUIDATV_SMB_IP` possono essere impostati nell'ambiente di Compose per usare percorsi o indirizzi diversi. Un valore vuoto per `GUIDATV_SMB_SHARE` disattiva la funzione.

## Sviluppo
`cd server && npm install && npm test`
