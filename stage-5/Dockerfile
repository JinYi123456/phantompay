# PhantomPay stage 5 — clean build with zero network access.
# There are no dependencies to install: the base image plus the source is enough.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0

COPY package.json server.js ./
COPY lib ./lib
COPY bin ./bin

EXPOSE 8000
USER node
CMD ["node", "server.js"]
