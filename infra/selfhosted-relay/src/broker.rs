use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot},
    time::{Instant, interval_at, timeout},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const MAX_MESSAGE: usize = 128 * 1024;
const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT: Duration = Duration::from_secs(30);
const MAX_HOSTS: usize = 128;
const MAX_CLIENTS: usize = 32;

#[derive(Clone)]
pub struct Broker {
    registry: Arc<Mutex<Registry>>,
    token_digest: [u8; 32],
    sockets: Arc<Semaphore>,
    shutdown: CancellationToken,
    pub tasks: TaskTracker,
}

#[derive(Default)]
struct Registry {
    hosts: HashMap<String, Arc<Host>>,
    pending: HashMap<String, Pending>,
}

struct Host {
    control: mpsc::Sender<Message>,
    clients: Arc<Semaphore>,
    cancelled: CancellationToken,
}

struct Pending {
    ticket_digest: [u8; 32],
    session: oneshot::Sender<LeasedSocket>,
}

struct LeasedSocket {
    socket: WebSocket,
    _permit: OwnedSemaphorePermit,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Registration {
    Host { route: String, token: String },
    Client { route: String },
    Session { id: String, ticket: String },
}

impl Broker {
    pub fn new(token: &str, shutdown: CancellationToken) -> Result<Self, &'static str> {
        if !(32..=1024).contains(&token.len()) {
            return Err("Use a relay registration token of 32 to 1024 bytes.");
        }
        Ok(Self {
            registry: Arc::default(),
            token_digest: digest(token),
            sockets: Arc::new(Semaphore::new(4096)),
            shutdown,
            tasks: TaskTracker::new(),
        })
    }

    async fn register(&self, mut socket: LeasedSocket) {
        let registration = tokio::select! {
            _ = self.shutdown.cancelled() => return,
            result = timeout(REGISTRATION_TIMEOUT, async {
                loop {
                    match socket.socket.recv().await {
                        Some(Ok(Message::Text(text))) if text.len() <= 2048 => {
                            return serde_json::from_str::<Registration>(&text).ok();
                        }
                        Some(Ok(Message::Ping(bytes))) => send(&mut socket.socket, Message::Pong(bytes)).await.ok()?,
                        Some(Ok(Message::Pong(_))) => {},
                        _ => return None,
                    }
                }
            }) => result.ok().flatten(),
        };
        match registration {
            Some(Registration::Host { route, token }) => self.host(socket, route, token).await,
            Some(Registration::Client { route }) => self.client(socket, route).await,
            Some(Registration::Session { id, ticket }) => {
                let pending = {
                    let mut registry = self.registry.lock().unwrap();
                    if registry.pending.get(&id).is_some_and(|entry| {
                        bool::from(entry.ticket_digest.ct_eq(&digest(&ticket)))
                    }) {
                        registry.pending.remove(&id)
                    } else {
                        None
                    }
                };
                if let Some(pending) = pending {
                    // Move the complete socket so buffered frames survive the session handoff.
                    let _ = pending.session.send(socket);
                } else {
                    close(&mut socket.socket, 1008).await;
                }
            }
            None => close(&mut socket.socket, 1008).await,
        }
    }

    async fn host(&self, mut socket: LeasedSocket, route: String, token: String) {
        if token.len() > 1024
            || !bool::from(self.token_digest.ct_eq(&digest(&token)))
            || route.len() != 32
            || !route
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            close(&mut socket.socket, 1008).await;
            return;
        }
        let (control, mut commands) = mpsc::channel(MAX_CLIENTS);
        let host = Arc::new(Host {
            control,
            clients: Arc::new(Semaphore::new(MAX_CLIENTS)),
            cancelled: self.shutdown.child_token(),
        });
        let accepted = {
            let mut registry = self.registry.lock().unwrap();
            if registry.hosts.len() >= MAX_HOSTS || registry.hosts.contains_key(&route) {
                false
            } else {
                registry.hosts.insert(route.clone(), host.clone());
                true
            }
        };
        if !accepted {
            close(&mut socket.socket, 1008).await;
            return;
        }
        let _guard = HostGuard {
            broker: self.clone(),
            route,
            host: host.clone(),
        };
        if send(&mut socket.socket, ready()).await.is_err() {
            return;
        }
        let mut heartbeat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
        let mut alive = true;
        loop {
            tokio::select! {
                _ = host.cancelled.cancelled() => break,
                command = commands.recv() => match command {
                    Some(message) => if send(&mut socket.socket, message).await.is_err() { break; },
                    None => break,
                },
                message = socket.socket.recv() => if !control_message(&mut socket.socket, message, &mut alive).await { break; },
                _ = heartbeat.tick() => if !ping(&mut socket.socket, &mut alive).await { break; },
            }
        }
        close(&mut socket.socket, 1012).await;
    }

    async fn client(&self, mut client: LeasedSocket, route: String) {
        let host = self.registry.lock().unwrap().hosts.get(&route).cloned();
        let Some(host) = host else {
            close(&mut client.socket, 1008).await;
            return;
        };
        let Ok(_client_permit) = host.clients.clone().try_acquire_owned() else {
            close(&mut client.socket, 1008).await;
            return;
        };
        let id = random_id();
        let ticket = random_id();
        let (session, mut receiver) = oneshot::channel();
        self.registry.lock().unwrap().pending.insert(
            id.clone(),
            Pending {
                ticket_digest: digest(&ticket),
                session,
            },
        );
        let guard = PendingGuard {
            broker: self.clone(),
            id: id.clone(),
        };
        let notification =
            serde_json::json!({ "type": "session", "id": id, "ticket": ticket }).to_string();
        if host
            .control
            .try_send(Message::Text(notification.into()))
            .is_err()
        {
            close(&mut client.socket, 1013).await;
            return;
        }
        let deadline = tokio::time::sleep(REGISTRATION_TIMEOUT);
        tokio::pin!(deadline);
        let mut alive = true;
        let mut session = loop {
            tokio::select! {
                _ = host.cancelled.cancelled() => { close(&mut client.socket, 1012).await; return; },
                _ = &mut deadline => { close(&mut client.socket, 1013).await; return; },
                result = &mut receiver => match result { Ok(socket) => break socket, Err(_) => return },
                message = client.socket.recv() => if !control_message(&mut client.socket, message, &mut alive).await { return; },
            }
        };
        drop(guard);
        if send(&mut session.socket, ready()).await.is_err()
            || send(&mut client.socket, ready()).await.is_err()
        {
            return;
        }
        let mut heartbeat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
        let (mut client_alive, mut session_alive) = (true, true);
        loop {
            tokio::select! {
                _ = host.cancelled.cancelled() => break,
                message = client.socket.recv() => if !forward(message, &mut client.socket, &mut session.socket, &mut client_alive).await { break; },
                message = session.socket.recv() => if !forward(message, &mut session.socket, &mut client.socket, &mut session_alive).await { break; },
                _ = heartbeat.tick() => {
                    if !ping(&mut client.socket, &mut client_alive).await || !ping(&mut session.socket, &mut session_alive).await { break; }
                },
            }
        }
        let code = if host.cancelled.is_cancelled() {
            1012
        } else {
            1000
        };
        let _ = tokio::join!(
            close(&mut client.socket, code),
            close(&mut session.socket, code)
        );
    }
}

struct HostGuard {
    broker: Broker,
    route: String,
    host: Arc<Host>,
}
impl Drop for HostGuard {
    fn drop(&mut self) {
        self.host.cancelled.cancel();
        self.broker
            .registry
            .lock()
            .unwrap()
            .hosts
            .remove(&self.route);
    }
}

struct PendingGuard {
    broker: Broker,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.broker
            .registry
            .lock()
            .unwrap()
            .pending
            .remove(&self.id);
    }
}

pub async fn upgrade(State(broker): State<Broker>, ws: WebSocketUpgrade) -> Response {
    let Ok(permit) = broker.sockets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if broker.shutdown.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE * 2)
        .on_upgrade(move |socket| async move {
            let task_broker = broker.clone();
            broker.tasks.spawn(async move {
                task_broker
                    .register(LeasedSocket {
                        socket,
                        _permit: permit,
                    })
                    .await;
            });
        })
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn random_id() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn ready() -> Message {
    Message::Text(r#"{"type":"ready"}"#.into())
}

async fn send(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    timeout(WRITE_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn close(socket: &mut WebSocket, code: u16) {
    let _ = send(
        socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: "Relay connection closed".into(),
        })),
    )
    .await;
}

async fn ping(socket: &mut WebSocket, alive: &mut bool) -> bool {
    if !*alive {
        return false;
    }
    *alive = false;
    send(socket, Message::Ping(Default::default()))
        .await
        .is_ok()
}

async fn control_message(
    socket: &mut WebSocket,
    message: Option<Result<Message, axum::Error>>,
    alive: &mut bool,
) -> bool {
    match message {
        Some(Ok(Message::Pong(_))) => {
            *alive = true;
            true
        }
        Some(Ok(Message::Ping(bytes))) => send(socket, Message::Pong(bytes)).await.is_ok(),
        Some(Ok(Message::Binary(_) | Message::Text(_))) => {
            close(socket, 1008).await;
            false
        }
        _ => false,
    }
}

async fn forward(
    message: Option<Result<Message, axum::Error>>,
    from: &mut WebSocket,
    to: &mut WebSocket,
    alive: &mut bool,
) -> bool {
    match message {
        Some(Ok(Message::Binary(bytes))) => send(to, Message::Binary(bytes)).await.is_ok(),
        other => control_message(from, other, alive).await,
    }
}
