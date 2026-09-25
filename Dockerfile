# jonIAs — imagem de produção.
# O banco NUNCA entra na imagem: vive no volume (DB_PATH=/app/data/aula-ai.db,
# definido no docker-compose.yml) e o .dockerignore barra *.db, data/, .env e
# planilhas. Ver DEPLOY.md.

# Estágio 1 — dependências. better-sqlite3 e argon2 são módulos nativos: quando
# não há binário pronto para a versão exata do Node, o npm compila na hora e
# precisa de python3/make/g++, que não vão para a imagem final.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# npm ci instala exatamente o package-lock.json e falha se ele estiver fora de
# sincronia com o package.json — nada de versão "parecida" em produção.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Estágio 2 — execução (mesma imagem base: os binários compilados batem)
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 8000
CMD ["node", "server.js"]
