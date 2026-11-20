FROM ghcr.io/iptv-org/epg:master

WORKDIR /epg/sites
RUN mv raiplay.it/raiplay.it.config.js raiplay.it/upstream.js \
 && mv mediasetinfinity.mediaset.it/mediasetinfinity.mediaset.it.config.js mediasetinfinity.mediaset.it/upstream.js
COPY raiplay.it.config.js raiplay.it/raiplay.it.config.js
COPY mediasetinfinity.mediaset.it.config.js mediasetinfinity.mediaset.it/mediasetinfinity.mediaset.it.config.js
WORKDIR /epg
