fn main() {
    let protoc = std::env::var("PROTOC").unwrap_or_else(|_| {
        r"C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\Google.Protobuf_Microsoft.Winget.Source_8wekyb3d8bbwe\bin\protoc.exe"
            .to_string()
    });
    std::env::set_var("PROTOC", &protoc);

    tonic_build::configure()
        .build_server(true)
        .compile_protos(&["../proto/mpc_service.proto"], &["../proto"])
        .expect("failed to compile MPC gRPC definitions");
}
