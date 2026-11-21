FROM node:22-alpine
RUN apk add --no-cache ffmpeg samba-client python3 py3-cryptography \
 && apk add --no-cache --virtual .pip py3-pip \
 && pip install --break-system-packages --no-cache-dir 'smbprotocol==1.17.0' \
 && apk del .pip
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
