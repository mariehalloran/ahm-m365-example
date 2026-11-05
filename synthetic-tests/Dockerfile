FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY exchange/src ./exchange/src
COPY teams/src ./teams/src
COPY onedrive/src ./onedrive/src
COPY sharepoint/src ./sharepoint/src
COPY utils/src ./utils/src
COPY functions/src ./functions/src
COPY coordinator/src ./coordinator/src
RUN npm run build

FROM node:22-bookworm-slim
ARG SOURCE_FINGERPRINT
LABEL monitoring.source.sha256=$SOURCE_FINGERPRINT
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/coordinator ./dist/coordinator
COPY --from=build /app/dist/utils ./dist/utils
COPY --from=build /app/dist/functions/src/dispatch.js ./dist/functions/src/dispatch.js
USER node
CMD ["node", "dist/coordinator/src/index.js"]
