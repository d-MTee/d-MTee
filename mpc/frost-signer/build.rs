fn main() {
    tonic_build::configure()
        .build_server(true)
        .compile_protos(&["../proto/mpc_service.proto"], &["../proto"])
        .expect("failed to compile MPC gRPC definitions");
}
