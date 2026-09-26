FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS build
RUN dnf install -y gcc gcc-c++ openssl-devel pkg-config curl tar gzip && dnf clean all
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /build
COPY Cargo.toml .
COPY src ./src
RUN cargo build --release --target x86_64-unknown-linux-musl
FROM scratch
COPY --from=build /build/target/x86_64-unknown-linux-musl/release/dflow-nitro-signer /app/dflow-nitro-signer
ENTRYPOINT ["/app/dflow-nitro-signer"]
