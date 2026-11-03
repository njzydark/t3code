FROM rust:1.90-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY infra/selfhosted-relay/Cargo.toml infra/selfhosted-relay/Cargo.lock ./
COPY infra/selfhosted-relay/src/*.rs ./src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release && cp target/release/t3-selfhosted-relay /t3-selfhosted-relay

FROM scratch AS core
COPY --from=builder /t3-selfhosted-relay /t3-selfhosted-relay
COPY LICENSE /LICENSE
USER 65532:65532
ENV HOST=0.0.0.0 PORT=8788
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/t3-selfhosted-relay", "healthcheck"]
ENTRYPOINT ["/t3-selfhosted-relay"]

FROM core AS web
COPY apps/web/dist /web
ENV T3_RELAY_WEB_ROOT=/web
