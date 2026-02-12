# Stage 1: Build client
FROM node:20-alpine AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY client/ ./client/
RUN npm run build -w client

# Stage 2: Build server
FROM node:20-alpine AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY server/ ./server/
RUN npm run build -w server

# Stage 3: Production
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --omit=dev

COPY --from=client-build /app/client/dist ./client/dist
COPY --from=server-build /app/server/dist ./server/dist

RUN mkdir -p /app/data

ENV PORT=3080
ENV NODE_ENV=production

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3080/api/health || exit 1

CMD ["node", "server/dist/index.js"]
