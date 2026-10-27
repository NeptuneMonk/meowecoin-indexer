FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "--experimental-sqlite", "--experimental-strip-types", "src/index.ts"]
