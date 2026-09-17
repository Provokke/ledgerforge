# One image for all four services. Pick which one with SERVICE (default gateway).
# Node 24 runs TypeScript directly, so there is no build step to go wrong.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/gateway/package.json services/gateway/
COPY services/accounts/package.json services/accounts/
COPY services/ledger/package.json services/ledger/
COPY services/matching/package.json services/matching/
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages packages
COPY services services
ARG SERVICE=gateway
ENV SERVICE=${SERVICE}
USER node
EXPOSE 3000
# exec form with sh -c so SERVICE can be set at run time; exec keeps node as PID 1 for signals
CMD ["sh", "-c", "exec node services/${SERVICE}/src/main.ts"]
