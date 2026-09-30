# Build the static UI, serve it with nginx, proxy /api to the API container.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# A template, not a config: the image's entrypoint substitutes BACKSTOP_* variables
# (and only those, so nginx's own $variables survive) into conf.d/default.conf.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
ENV BACKSTOP_API_UPSTREAM=api:8000 \
    NGINX_ENVSUBST_FILTER=^BACKSTOP_
EXPOSE 80
