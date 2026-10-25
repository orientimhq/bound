# Orientim's verifier. Build from the repository root: docker build -f verifier/Dockerfile .
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
RUN npm ci --omit=dev --ignore-scripts
COPY sdk/src sdk/src
COPY verifier/src verifier/src
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "verifier/src/server.ts"]
