FROM node:24-bookworm-slim
# flock is an OS-level single-writer lock, including cooperating NFS/CFS clients.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 STORAGE_DRIVER=snapshot DATA_DIR=/mnt/moon-table
COPY package.json *.mjs *.css *.html *.webp *.svg *.webmanifest ./
COPY assets/ ./assets/
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh && mkdir -p /mnt/moon-table
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
