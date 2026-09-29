FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS build
RUN dnf install -y gcc gcc-c++ openssl-devel pkg-config curl tar gzip && dnf clean all
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /build
ARG NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX
ARG NITRO_PARTICIPANT_ID
ARG NITRO_SIGNING_KEY_ID
ENV NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX=${NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX}
ENV NITRO_PARTICIPANT_ID=${NITRO_PARTICIPANT_ID}
ENV NITRO_SIGNING_KEY_ID=${NITRO_SIGNING_KEY_ID}
COPY Cargo.toml .
COPY src ./src
RUN cargo build --release --target x86_64-unknown-linux-musl
FROM scratch
ARG NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX
ARG NITRO_PARTICIPANT_ID
ARG NITRO_SIGNING_KEY_ID
ENV NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX=${NITRO_POLICY_AUTHORITY_PUBLIC_KEY_HEX}
ENV NITRO_PARTICIPANT_ID=${NITRO_PARTICIPANT_ID}
ENV NITRO_SIGNING_KEY_ID=${NITRO_SIGNING_KEY_ID}
COPY --from=build /build/target/x86_64-unknown-linux-musl/release/dflow-nitro-signer /app/dflow-nitro-signer
ENTRYPOINT ["/app/dflow-nitro-signer"]
