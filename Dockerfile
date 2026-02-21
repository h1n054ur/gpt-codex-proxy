FROM node:20-alpine

WORKDIR /app

COPY src/server.mjs ./src/server.mjs

EXPOSE 8080

CMD ["node", "src/server.mjs"]
