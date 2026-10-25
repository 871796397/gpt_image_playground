//! 命令行程序，安装为 `<安装目录>\bin\gpt-image-playground.exe`，见 `cli::command`
fn main() -> std::process::ExitCode {
    gpt_image_playground_lib::run_cli()
}
