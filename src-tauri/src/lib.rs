use std::path::PathBuf;
use tauri::Manager;

/// 随应用打包的 ffmpeg 路径（与主程序在同一文件夹），传给 yt-dlp 的 --ffmpeg-location
#[tauri::command]
fn ffmpeg_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let p: PathBuf = exe.parent().ok_or("找不到程序所在文件夹")?.join(name);
    if p.exists() {
        Ok(p.to_string_lossy().into_owned())
    } else {
        Err(format!("没有找到内置 ffmpeg：{}", p.display()))
    }
}

/// 把应用数据目录下 yt-dlp 文件夹里的文件设为可执行（macOS）。只接受该文件夹内的路径。
#[tauri::command]
fn make_executable(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("yt-dlp");
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let target = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&dir) || target == dir {
        return Err("只能设置 yt-dlp 文件夹内的文件".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ffmpeg_path, make_executable])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
