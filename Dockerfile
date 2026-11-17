FROM node:20-bookworm-slim
WORKDIR /app
COPY server ./server
COPY public ./public
USER node
EXPOSE 8090
CMD ["node","server/main.mjs"]
