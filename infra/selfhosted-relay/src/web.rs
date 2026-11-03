use std::path::{Component, Path, PathBuf};

use axum::{
    Extension,
    body::Body,
    extract::Request,
    http::{Method, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tokio_util::io::ReaderStream;

pub async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert("no-store".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "frame-ancestors 'none'; base-uri 'self'".parse().unwrap(),
    );
    response
}

pub async fn serve(
    Extension(root): Extension<Option<PathBuf>>,
    method: Method,
    uri: Uri,
) -> Response {
    match serve_file(root.as_deref(), method, uri).await {
        Ok(response) => response,
        Err(status) => status.into_response(),
    }
}

async fn serve_file(root: Option<&Path>, method: Method, uri: Uri) -> Result<Response, StatusCode> {
    let root = root.ok_or(StatusCode::NOT_FOUND)?;
    if method != Method::GET && method != Method::HEAD {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = percent_encoding::percent_decode_str(uri.path())
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if path.contains(['\0', '\\']) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let relative = Path::new(path.trim_start_matches('/'));
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if relative.extension().is_some_and(|ext| ext == "map") {
        return Err(StatusCode::NOT_FOUND);
    }
    let candidate = root.join(relative);
    let chosen = if tokio::fs::metadata(&candidate)
        .await
        .is_ok_and(|meta| meta.is_file())
    {
        candidate
    } else if relative.extension().is_none() {
        root.join("index.html")
    } else {
        return Err(StatusCode::NOT_FOUND);
    };
    let file_path = tokio::fs::canonicalize(chosen)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !file_path.starts_with(root) {
        return Err(StatusCode::NOT_FOUND);
    }
    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let metadata = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, metadata.len())
        .header(
            header::CACHE_CONTROL,
            if path.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-store"
            },
        )
        .body(body)
        .unwrap())
}
