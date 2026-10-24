FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY config ./config

ENV HOST=0.0.0.0
ENV PORT=8788

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/symbols').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["npm", "start"]
