#
# BUILD CONTAINER
#
FROM node:22.15.0-alpine3.21 AS base
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node .yarn/releases ./.yarn/releases
COPY --chown=node:node package.json yarn.lock .yarnrc.yml tsconfig*.json ./
COPY --chown=node:node scripts/generate-abis.js ./scripts/generate-abis.js
COPY --chown=node:node assets ./assets
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
RUN yarn install --immutable \
     && yarn run build \
     && rm -rf ./node_modules \
     && yarn workspaces focus --production

#
# PRODUCTION CONTAINER
#
FROM node:22.15.0-alpine3.21 AS production
USER node

ARG VERSION
ARG BUILD_NUMBER

ENV APPLICATION_VERSION=${VERSION} \
    APPLICATION_BUILD_NUMBER=${BUILD_NUMBER} \
    NODE_ENV=production

COPY --chown=node:node --from=base /app/abis ./abis
COPY --chown=node:node --from=base /app/node_modules ./node_modules
COPY --chown=node:node --from=base /app/dist ./dist
COPY --chown=node:node --from=base /app/assets ./assets
COPY --chown=node:node --from=base /app/migrations ./migrations
CMD [ "node", "dist/src/main.js" ]
