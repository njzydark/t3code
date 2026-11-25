use crate::broker::{Broker, GatewayLease};
use axum::{
    body::{Body, to_bytes},
    extract::ws::Message,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use futures_util::{SinkExt, stream};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY: usize = 8 * 1024 * 1024;

pub async fn directory(State(broker): State<Broker>, headers: HeaderMap) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    match broker.discover(token) {
        Some(environments) => (
            [("cache-control", "no-store")],
            axum::Json(json!({"environments":environments})),
        )
            .into_response(),
        None => StatusCode::UNAUTHORIZED.into_response(),
    }
}

fn allowed(path: &str) -> bool {
    matches!(
        path,
        "/mcp"
            | "/.well-known/t3/environment"
            | "/.well-known/oauth-protected-resource/mcp"
            | "/.well-known/oauth-authorization-server"
            | "/oauth/mcp/register"
            | "/oauth/mcp/decision"
            | "/oauth/mcp/token"
            | "/oauth/mcp/revoke"
    ) || matches!(
        path,
        "/api/peer-link/client-pairing"
            | "/api/links/thread/stream"
            | "/api/links/thread/history"
            | "/api/links/thread/item"
    )
}

#[derive(Deserialize)]
struct Head {
    status: u16,
    headers: Vec<(String, String)>,
}

async fn receive(lease: &mut GatewayLease) -> Result<Message, StatusCode> {
    loop {
        let value = tokio::select! {
            _ = lease.cancelled.cancelled() => return Err(StatusCode::BAD_GATEWAY),
            value = lease.socket.recv() => value.ok_or(StatusCode::BAD_GATEWAY)?.map_err(|_| StatusCode::BAD_GATEWAY)?,
        };
        match value {
            Message::Ping(bytes) => send(lease, Message::Pong(bytes)).await?,
            Message::Pong(_) => {}
            value => return Ok(value),
        }
    }
}

async fn next(lease: &mut GatewayLease) -> Result<Message, StatusCode> {
    tokio::time::timeout(TIMEOUT, receive(lease))
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
}

async fn send(lease: &mut GatewayLease, message: Message) -> Result<(), StatusCode> {
    tokio::time::timeout(TIMEOUT, lease.socket.send(message))
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn forward(
    broker: Broker,
    environment_id: String,
    path: String,
    request: Request,
) -> Result<Response, StatusCode> {
    let path = format!("/{path}");
    if !allowed(&path) || path.contains('\\') || path.contains("..") {
        return Err(StatusCode::NOT_FOUND);
    }
    let (parts, body) = request.into_parts();
    if !matches!(
        parts.method.as_str(),
        "GET" | "HEAD" | "POST" | "DELETE" | "OPTIONS"
    ) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let body = to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let headers: Vec<_> = parts
        .headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v)))
        .collect();
    if headers.len() > 128 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut lease = broker.open_gateway(&environment_id).await?;
    let path = match parts.uri.query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let metadata =
        json!({"path":path,"method":parts.method.as_str(),"headers":headers}).to_string();
    if metadata.len() > 60 * 1024 {
        return Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE);
    }
    send(&mut lease, Message::Text(metadata.into())).await?;
    for chunk in body.chunks(60 * 1024) {
        send(&mut lease, Message::Binary(chunk.to_vec().into())).await?;
        if next(&mut lease).await? != Message::Text("ack".into()) {
            return Err(StatusCode::BAD_GATEWAY);
        }
    }
    send(&mut lease, Message::Text("end".into())).await?;
    let Message::Text(head) = next(&mut lease).await? else {
        return Err(StatusCode::BAD_GATEWAY);
    };
    let head: Head = serde_json::from_str(&head).map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = StatusCode::from_u16(head.status).map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !status.is_success()
        && !status.is_client_error()
        && !status.is_server_error()
        && !status.is_redirection()
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut response = Response::builder().status(status);
    for (name, value) in head.headers {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "connection"
                | "transfer-encoding"
                | "set-cookie"
                | "content-length"
                | "keep-alive"
                | "upgrade"
        ) {
            response = response.header(name, value);
        }
    }
    response = response.header("cache-control", "no-store");
    let (writer, receiver) = tokio::sync::mpsc::channel(1);
    broker.tasks.spawn(async move {
        loop {
            if writer.is_closed() {
                break;
            }
            let pending = async {
                send(&mut lease, Message::Text("pull".into())).await?;
                receive(&mut lease).await
            };
            let message = tokio::select! { _ = writer.closed() => break, value = pending => value };
            match message {
                Ok(Message::Binary(bytes)) => {
                    if writer.send(Ok::<_, std::io::Error>(bytes)).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Text(text)) if text == "end" => break,
                _ => {
                    let _ = writer
                        .send(Err(std::io::Error::other("Relay response interrupted")))
                        .await;
                    break;
                }
            }
        }
        let _ = lease.socket.close().await;
    });
    let output = stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|item| (item, receiver))
    });
    response
        .body(Body::from_stream(output))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

pub async fn gateway(
    State(broker): State<Broker>,
    Path((environment_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    match forward(broker, environment_id, path, request).await {
        Ok(response) => response,
        Err(status) => status.into_response(),
    }
}
