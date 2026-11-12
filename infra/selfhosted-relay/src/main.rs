mod broker;
mod push;
mod web;

use std::{
    env,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

use axum::{Router, middleware, routing::get};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn bind_address() -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let host: IpAddr = env::var("HOST")
        .unwrap_or_else(|_| "0.0.0.0".into())
        .parse()?;
    let port = env::var("PORT").unwrap_or_else(|_| "8788".into()).parse()?;
    Ok(SocketAddr::new(host, port))
}

fn healthcheck() -> Result<(), Box<dyn std::error::Error>> {
    let mut address = bind_address()?;
    if address.ip().is_unspecified() {
        address.set_ip(
            if address.is_ipv4() {
                "127.0.0.1"
            } else {
                "::1"
            }
            .parse()?,
        );
    }
    let deadline = Duration::from_secs(2);
    let mut socket = TcpStream::connect_timeout(&address, deadline)?;
    socket.set_read_timeout(Some(deadline))?;
    socket.set_write_timeout(Some(deadline))?;
    socket.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut status = [0; 12];
    socket.read_exact(&mut status)?;
    if &status != b"HTTP/1.1 200" {
        return Err("Relay healthcheck failed".into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let token = env::var("T3_RELAY_REGISTRATION_TOKEN")?;
    let shutdown = CancellationToken::new();
    let state = broker::Broker::new(&token, shutdown.clone())?;
    let push = push::Push::from_env(&token)?;
    let web_root = match env::var_os("T3_RELAY_WEB_ROOT") {
        Some(path) => Some(tokio::fs::canonicalize(PathBuf::from(path)).await?),
        None => None,
    };
    let mut app = Router::new()
        .route(
            "/healthz",
            get(|| async { axum::Json(serde_json::json!({"ok": true})) }),
        )
        .route("/v1/socket", get(broker::upgrade))
        .fallback(web::serve)
        .layer(axum::Extension(web_root))
        .layer(middleware::from_fn(web::security_headers))
        .with_state(state.clone());
    if let Some(push) = push {
        app = app.merge(push.router());
        state.tasks.spawn(push.run(shutdown.clone()));
    }
    let listener = TcpListener::bind(bind_address()?).await?;
    println!(
        "T3 self-hosted relay listening on http://{}",
        listener.local_addr()?
    );
    let signal = shutdown.clone();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("install SIGTERM handler");
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = terminate.recv() => {},
                }
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
            signal.cancel();
        })
        .await;
    shutdown.cancel();
    state.tasks.close();
    state.tasks.wait().await;
    result?;
    Ok(())
}
