use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

const MAX_DEVICES: usize = 2048;
const MAX_ROWS: usize = 8192;
const MAX_JOBS: i64 = 8192;

#[derive(Clone)]
pub struct Push {
    inner: Arc<Mutex<Store>>,
    credentials: Arc<Credentials>,
    token_digest: [u8; 32],
    notify: Arc<Notify>,
}

struct Credentials {
    team: String,
    key_id: String,
    key: EncodingKey,
    bundle: String,
    environment: String,
    client: reqwest::Client,
    jwt: Mutex<Option<(u64, String)>>,
    #[cfg(test)]
    endpoint: Option<String>,
}

struct Store {
    db: Connection,
    data: Data,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Data {
    devices: Vec<Device>,
    rows: HashMap<String, Activity>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    environment_id: String,
    session_id: String,
    registration: Registration,
    activity_token: Option<String>,
    last_seen: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    device_id: String,
    platform: String,
    bundle_id: Option<String>,
    aps_environment: Option<String>,
    push_token: Option<String>,
    preferences: Preferences,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    notifications_enabled: bool,
    live_activities_enabled: bool,
    notify_on_approval: bool,
    notify_on_input: bool,
    notify_on_completion: bool,
    notify_on_failure: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    environment_id: String,
    thread_id: String,
    project_title: String,
    thread_title: String,
    model_title: String,
    phase: String,
    updated_at: String,
    deep_link: String,
}

impl Activity {
    fn terminal(&self) -> bool {
        matches!(self.phase.as_str(), "completed" | "failed")
    }
    fn status(&self) -> &'static str {
        match self.phase.as_str() {
            "waiting_for_approval" => "Approval",
            "waiting_for_input" => "Input",
            "completed" => "Done",
            "failed" => "Failed",
            "starting" => "Connecting",
            "running" => "Working",
            _ => "Waiting",
        }
    }
    fn time(&self) -> Option<u64> {
        chrono::DateTime::parse_from_rfc3339(&self.updated_at)
            .ok()
            .and_then(|date| u64::try_from(date.timestamp()).ok())
    }
    fn row(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("serialize activity");
        value["status"] = json!(self.status());
        value
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    environment_id: String,
    active_session_ids: Vec<String>,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
enum Operation {
    Capabilities,
    Register {
        #[serde(rename = "sessionId")]
        session_id: String,
        registration: Registration,
    },
    Activity {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "activityPushToken")]
        activity_push_token: String,
    },
    Unregister {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Snapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Publish {
        #[serde(rename = "threadId")]
        thread_id: String,
        state: Option<Activity>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct Job {
    token: String,
    live: bool,
    payload: Value,
    attempts: u32,
    expires: u64,
    #[serde(default)]
    fallback: Option<Box<Job>>,
    #[serde(default)]
    bindings: Vec<(String, String, String)>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_secs()
}
fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}
fn valid_token(text: &str) -> bool {
    (32..=512).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control)
}

impl Push {
    pub fn from_env(token: &str) -> Result<Option<Self>, Box<dyn std::error::Error>> {
        match env::var("T3_RELAY_PUSH_ENABLED").as_deref() {
            Err(_) | Ok("false") | Ok("0") => return Ok(None),
            Ok("true") | Ok("1") => {}
            _ => return Err("T3_RELAY_PUSH_ENABLED must be true or false".into()),
        }
        let bundle = env::var("APNS_BUNDLE_ID")?;
        if bundle.is_empty()
            || bundle.len() > 255
            || !bundle
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        {
            return Err("Invalid APNS_BUNDLE_ID".into());
        }
        let environment = env::var("APNS_ENVIRONMENT").unwrap_or_else(|_| "production".into());
        if !matches!(environment.as_str(), "production" | "sandbox") {
            return Err("Invalid APNS_ENVIRONMENT".into());
        }
        let pem = std::fs::read(env::var("APNS_PRIVATE_KEY_FILE")?)?;
        let credentials = Credentials {
            team: env::var("APNS_TEAM_ID")?,
            key_id: env::var("APNS_KEY_ID")?,
            key: EncodingKey::from_ec_pem(&pem)?,
            bundle,
            environment,
            client: reqwest::Client::builder()
                .https_only(true)
                .http2_prior_knowledge()
                .timeout(Duration::from_secs(10))
                .build()?,
            jwt: Mutex::new(None),
            #[cfg(test)]
            endpoint: None,
        };
        if [&credentials.team, &credentials.key_id]
            .iter()
            .any(|id| id.len() != 10 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        {
            return Err(
                "APNS_TEAM_ID and APNS_KEY_ID must be ten-character Apple identifiers".into(),
            );
        }
        encode(
            &Header::new(Algorithm::ES256),
            &json!({"iss": credentials.team, "iat": now()}),
            &credentials.key,
        )?;
        let db = Connection::open(env::var("T3_RELAY_PUSH_DATABASE")?)?;
        Self::open(db, credentials, token).map(Some)
    }

    fn open(
        db: Connection,
        credentials: Credentials,
        token: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, data TEXT NOT NULL, due INTEGER NOT NULL);")?;
        let data = match db.query_row("SELECT data FROM state WHERE id=1", [], |row| {
            row.get::<_, String>(0)
        }) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(rusqlite::Error::QueryReturnedNoRows) => Data::default(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(Store { db, data })),
            credentials: Arc::new(credentials),
            token_digest: digest(token),
            notify: Arc::new(Notify::new()),
        })
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/push", post(handle))
            .layer(DefaultBodyLimit::max(128 * 1024))
            .with_state(self.clone())
    }

    fn authorize(&self, headers: &HeaderMap) -> bool {
        headers
            .get("authorization")
            .and_then(|header| header.to_str().ok())
            .and_then(|header| header.strip_prefix("Bearer "))
            .is_some_and(|token| {
                token.len() <= 1024 && bool::from(digest(token).ct_eq(&self.token_digest))
            })
    }

    async fn apply(&self, input: Request) -> Result<Value, StatusCode> {
        if !valid_id(&input.environment_id) || input.active_session_ids.len() > MAX_DEVICES {
            return Err(StatusCode::BAD_REQUEST);
        }
        let mut store = self.inner.lock().await;
        let mut data = store.data.clone();
        let now = now();
        data.devices.retain(|device| {
            now.saturating_sub(device.last_seen) < 30 * 86400
                && (device.environment_id != input.environment_id
                    || input.active_session_ids.contains(&device.session_id))
        });
        data.rows.retain(|_, row| {
            row.time().is_some_and(|at| {
                now.saturating_sub(at)
                    <= if matches!(row.phase.as_str(), "starting" | "running") {
                        7200
                    } else {
                        86400
                    }
            })
        });
        let mut jobs = Vec::new();
        let mut response = json!({"ok": true});
        let session_device = |session: &str, id: &str, data: &Data| -> Result<usize, StatusCode> {
            if !input
                .active_session_ids
                .iter()
                .any(|value| value == session)
            {
                return Err(StatusCode::FORBIDDEN);
            }
            data.devices
                .iter()
                .position(|d| {
                    d.environment_id == input.environment_id
                        && d.session_id == session
                        && d.registration.device_id == id
                })
                .ok_or(StatusCode::NOT_FOUND)
        };
        match input.operation {
            Operation::Capabilities => {
                response = json!({"enabled": true, "platforms": ["ios"], "bundleId": self.credentials.bundle, "apsEnvironment": self.credentials.environment});
            }
            Operation::Register {
                session_id,
                registration,
            } => {
                if !input.active_session_ids.contains(&session_id) {
                    return Err(StatusCode::FORBIDDEN);
                }
                if registration.platform != "ios"
                    || registration.bundle_id.as_deref() != Some(&self.credentials.bundle)
                    || registration.aps_environment.as_deref()
                        != Some(&self.credentials.environment)
                {
                    return Err(StatusCode::UNPROCESSABLE_ENTITY);
                }
                if !valid_id(&registration.device_id)
                    || registration
                        .push_token
                        .as_deref()
                        .is_some_and(|token| !valid_token(token))
                {
                    return Err(StatusCode::BAD_REQUEST);
                }
                let previous = data
                    .devices
                    .iter()
                    .find(|d| {
                        d.environment_id == input.environment_id
                            && d.session_id == session_id
                            && d.registration.device_id == registration.device_id
                    })
                    .cloned();
                data.devices.retain(|d| {
                    !(d.environment_id == input.environment_id
                        && d.registration.device_id == registration.device_id)
                });
                if data.devices.len() >= MAX_DEVICES {
                    return Err(StatusCode::SERVICE_UNAVAILABLE);
                }
                let mut device = Device {
                    environment_id: input.environment_id.clone(),
                    session_id,
                    registration,
                    activity_token: previous.and_then(|d| d.activity_token),
                    last_seen: now,
                };
                if !device.registration.preferences.live_activities_enabled
                    && let Some(token) = device.activity_token.take()
                {
                    jobs.push(live_job(token, None, None, now));
                }
                data.devices.push(device);
            }
            Operation::Activity {
                session_id,
                device_id,
                activity_push_token,
            } => {
                if !valid_token(&activity_push_token) {
                    return Err(StatusCode::BAD_REQUEST);
                }
                let index = session_device(&session_id, &device_id, &data)?;
                if !data.devices[index]
                    .registration
                    .preferences
                    .live_activities_enabled
                {
                    return Err(StatusCode::CONFLICT);
                }
                data.devices[index].activity_token = Some(activity_push_token.clone());
                data.devices[index].last_seen = now;
                let aggregate = aggregate_for(&data, &device_id, now);
                jobs.push(live_job(activity_push_token, aggregate.as_ref(), None, now));
            }
            Operation::Unregister {
                session_id,
                device_id,
            } => {
                let index = session_device(&session_id, &device_id, &data)?;
                let removed = data.devices.remove(index);
                if !data
                    .devices
                    .iter()
                    .any(|d| d.registration.device_id == device_id)
                    && let Some(token) = removed.activity_token
                {
                    jobs.push(live_job(token, None, None, now));
                }
            }
            Operation::Snapshot {
                session_id,
                device_id,
            } => {
                session_device(&session_id, &device_id, &data)?;
                response = json!({"aggregate": aggregate_for(&data, &device_id, now)});
            }
            Operation::Publish { thread_id, state } => {
                if !valid_id(&thread_id) {
                    return Err(StatusCode::BAD_REQUEST);
                }
                let key = format!("{}\0{}", input.environment_id, thread_id);
                let previous = data.rows.get(&key).cloned();
                if let Some(mut state) = state {
                    if state.environment_id != input.environment_id
                        || state.thread_id != thread_id
                        || !matches!(
                            state.phase.as_str(),
                            "starting"
                                | "running"
                                | "waiting_for_approval"
                                | "waiting_for_input"
                                | "completed"
                                | "failed"
                                | "stale"
                        )
                        || state.time().is_none_or(|time| time > now + 60)
                    {
                        return Err(StatusCode::BAD_REQUEST);
                    }
                    state.project_title = bounded_text(&state.project_title, 120);
                    state.thread_title = bounded_text(&state.thread_title, 120);
                    state.model_title = bounded_text(&state.model_title, 120);
                    if !state.deep_link.starts_with('/')
                        || state.deep_link.starts_with("//")
                        || state.deep_link.len() > 512
                    {
                        state.deep_link = "/".into();
                    }
                    if data.rows.len() >= MAX_ROWS && !data.rows.contains_key(&key) {
                        return Err(StatusCode::SERVICE_UNAVAILABLE);
                    }
                    data.rows.insert(key, state.clone());
                    let changed = previous
                        .as_ref()
                        .is_some_and(|old| phase_transition_alerts(old, &state));
                    let mut delivered_devices = std::collections::HashSet::new();
                    for device in data
                        .devices
                        .iter()
                        .filter(|d| d.environment_id == input.environment_id)
                    {
                        if !delivered_devices.insert(&device.registration.device_id) {
                            continue;
                        }
                        let alert =
                            changed && alert_allowed(&device.registration.preferences, &state, now);
                        let aggregate = aggregate_for(&data, &device.registration.device_id, now);
                        let live = device
                            .registration
                            .preferences
                            .live_activities_enabled
                            .then_some(device.activity_token.as_ref())
                            .flatten();
                        if let Some(token) = live {
                            let mut job = live_job(
                                token.clone(),
                                aggregate.as_ref(),
                                alert.then_some(&state),
                                now,
                            );
                            if alert {
                                job.fallback =
                                    device.registration.push_token.as_ref().map(|token| {
                                        Box::new(notification_job(token.clone(), &state, now))
                                    });
                            }
                            jobs.push(job);
                        } else if alert && let Some(token) = device.registration.push_token.as_ref()
                        {
                            jobs.push(notification_job(token.clone(), &state, now));
                        }
                    }
                } else if previous.is_some() {
                    data.rows.remove(&key);
                    for device in data.devices.iter().filter(|d| {
                        d.environment_id == input.environment_id
                            && d.registration.preferences.live_activities_enabled
                    }) {
                        if let Some(token) = &device.activity_token {
                            let aggregate =
                                aggregate_for(&data, &device.registration.device_id, now);
                            jobs.push(live_job(token.clone(), aggregate.as_ref(), None, now));
                        }
                    }
                }
            }
        }
        for job in &mut jobs {
            let ids: Vec<_> = data
                .devices
                .iter()
                .filter(|d| {
                    d.activity_token.as_ref() == Some(&job.token)
                        || d.registration.push_token.as_ref() == Some(&job.token)
                })
                .map(|d| &d.registration.device_id)
                .collect();
            job.bindings = data
                .devices
                .iter()
                .filter(|d| ids.contains(&&d.registration.device_id))
                .map(|d| {
                    (
                        d.environment_id.clone(),
                        d.session_id.clone(),
                        d.registration.device_id.clone(),
                    )
                })
                .collect();
            if let Some(fallback) = &mut job.fallback {
                fallback.bindings = job.bindings.clone();
            }
        }
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let tx = store.db.transaction()?;
            let count: i64 = tx.query_row("SELECT count(*) FROM jobs", [], |row| row.get(0))?;
            if count + jobs.len() as i64 > MAX_JOBS {
                return Err("queue full".into());
            }
            tx.execute("INSERT INTO state(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [serde_json::to_string(&data)?])?;
            for job in jobs {
                tx.execute(
                    "INSERT INTO jobs(data,due) VALUES(?1,?2)",
                    params![serde_json::to_string(&job)?, now],
                )?;
            }
            tx.commit()?;
            Ok(())
        })();
        result.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        store.data = data;
        self.notify.notify_one();
        Ok(response)
    }

    pub async fn run(self, shutdown: CancellationToken) {
        loop {
            let job = {
                let store = self.inner.lock().await;
                store
                    .db
                    .query_row(
                        "SELECT id,data FROM jobs WHERE due<=?1 ORDER BY id LIMIT 1",
                        [now()],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    )
                    .ok()
            };
            if let Some((id, text)) = job {
                if let Ok(job) = serde_json::from_str::<Job>(&text) {
                    let allowed = {
                        let store = self.inner.lock().await;
                        job_authorized(&job, &store.data)
                    };
                    let sent = job.expires > now() && allowed;
                    let result = if sent {
                        self.send(&job).await
                    } else {
                        Ok((false, None))
                    };
                    let mut store = self.inner.lock().await;
                    match result {
                        Ok((true, _)) | Err(_) if job.attempts < 5 && job.expires > now() => {
                            let mut retry = job.clone();
                            retry.attempts += 1;
                            if let Ok(text) = serde_json::to_string(&retry) {
                                let _ = store.db.execute(
                                    "UPDATE jobs SET data=?1,due=?2 WHERE id=?3",
                                    params![text, now() + (1 << retry.attempts), id],
                                );
                            }
                        }
                        result => {
                            let _ = store.db.execute("DELETE FROM jobs WHERE id=?1", [id]);
                            if sent
                                && matches!(&result, Ok((false, None)))
                                && job.live
                                && job.payload["aps"]["event"] == "end"
                            {
                                for device in &mut store.data.devices {
                                    if device.activity_token.as_ref() == Some(&job.token) {
                                        device.activity_token = None;
                                    }
                                }
                                if let Ok(text) = serde_json::to_string(&store.data) {
                                    let _ = store
                                        .db
                                        .execute("UPDATE state SET data=?1 WHERE id=1", [text]);
                                }
                            }
                            if let Ok((_, Some(reason))) = result {
                                if matches!(
                                    reason.as_str(),
                                    "Unregistered" | "BadDeviceToken" | "DeviceTokenNotForTopic"
                                ) {
                                    for device in &mut store.data.devices {
                                        let token = if job.live {
                                            &mut device.activity_token
                                        } else {
                                            &mut device.registration.push_token
                                        };
                                        if token.as_ref() == Some(&job.token) {
                                            *token = None;
                                        }
                                    }
                                    if let Ok(text) = serde_json::to_string(&store.data) {
                                        let _ = store
                                            .db
                                            .execute("UPDATE state SET data=?1 WHERE id=1", [text]);
                                    }
                                    if let Some(fallback) =
                                        job.fallback.filter(|job| job.expires > now())
                                        && let Ok(text) = serde_json::to_string(&fallback)
                                    {
                                        let _ = store.db.execute(
                                            "INSERT INTO jobs(data,due) VALUES(?1,?2)",
                                            params![text, now()],
                                        );
                                    }
                                }
                                eprintln!(
                                    "APNs rejected a self-hosted push: {}",
                                    bounded_text(&reason, 80)
                                );
                            }
                        }
                    }
                } else {
                    let _ = self
                        .inner
                        .lock()
                        .await
                        .db
                        .execute("DELETE FROM jobs WHERE id=?1", [id]);
                }
                if shutdown.is_cancelled() {
                    return;
                }
                continue;
            }
            tokio::select! { _ = shutdown.cancelled() => return, _ = self.notify.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
        }
    }

    async fn send(
        &self,
        job: &Job,
    ) -> Result<(bool, Option<String>), Box<dyn std::error::Error + Send + Sync>> {
        let c = &self.credentials;
        let jwt = {
            let mut cached = c.jwt.lock().await;
            if cached
                .as_ref()
                .is_none_or(|(issued, _)| now().saturating_sub(*issued) >= 2400)
            {
                let issued = now();
                let mut header = Header::new(Algorithm::ES256);
                header.kid = Some(c.key_id.clone());
                *cached = Some((
                    issued,
                    encode(&header, &json!({"iss": c.team, "iat": issued}), &c.key)?,
                ));
            }
            cached.as_ref().expect("cached provider token").1.clone()
        };
        let host = if c.environment == "production" {
            "api.push.apple.com"
        } else {
            "api.sandbox.push.apple.com"
        };
        let topic = if job.live {
            format!("{}.push-type.liveactivity", c.bundle)
        } else {
            c.bundle.clone()
        };
        let url = format!("https://{host}/3/device/{}", job.token);
        #[cfg(test)]
        let url = c
            .endpoint
            .as_ref()
            .map(|base| format!("{base}/3/device/{}", job.token))
            .unwrap_or(url);
        let response = c
            .client
            .post(url)
            .bearer_auth(jwt)
            .header("apns-topic", topic)
            .header(
                "apns-push-type",
                if job.live { "liveactivity" } else { "alert" },
            )
            .header(
                "apns-priority",
                if job.live
                    && job.payload["aps"]["alert"].is_null()
                    && job.payload["aps"]["event"] != "end"
                {
                    "5"
                } else {
                    "10"
                },
            )
            .header("apns-expiration", job.expires.to_string())
            .json(&job.payload)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Ok((
            status.as_u16() == 429 || status.is_server_error(),
            body["reason"].as_str().map(str::to_owned),
        ))
    }
}

async fn handle(
    State(push): State<Push>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<Value>, StatusCode> {
    if !push.authorize(&headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    push.apply(request).await.map(Json)
}

fn bounded_text(text: &str, limit: usize) -> String {
    text.trim().chars().take(limit).collect()
}

fn aggregate_for(data: &Data, device_id: &str, now: u64) -> Option<Value> {
    let environments: std::collections::HashSet<_> = data
        .devices
        .iter()
        .filter(|d| d.registration.device_id == device_id)
        .map(|d| &d.environment_id)
        .collect();
    let mut rows: Vec<_> = data
        .rows
        .values()
        .filter(|row| {
            environments.contains(&row.environment_id)
                && row.time().is_some_and(|at| {
                    now.saturating_sub(at)
                        <= if row.terminal() {
                            900
                        } else if matches!(row.phase.as_str(), "starting" | "running") {
                            7200
                        } else {
                            86400
                        }
                })
        })
        .collect();
    rows.sort_by(|a, b| {
        let rank = |row: &Activity| match row.phase.as_str() {
            "waiting_for_approval" | "waiting_for_input" => 0,
            "starting" | "running" => 1,
            "stale" => 2,
            _ => 3,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.thread_id.cmp(&b.thread_id))
    });
    let latest = rows.iter().max_by_key(|row| &row.updated_at)?;
    let active = rows.iter().filter(|row| !row.terminal()).count();
    Some(
        json!({"title": "T3 Code", "subtitle": if active > 0 {"Agent work in progress"} else if latest.phase == "failed" {"Agent work failed"} else {"Agent work completed"}, "activeCount": active, "updatedAt": latest.updated_at, "activities": rows.iter().take(5).map(|row| row.row()).collect::<Vec<_>>()}),
    )
}

fn alert_allowed(p: &Preferences, state: &Activity, now: u64) -> bool {
    p.notifications_enabled
        && match state.phase.as_str() {
            "waiting_for_approval" => p.notify_on_approval,
            "waiting_for_input" => p.notify_on_input,
            "completed" => {
                p.notify_on_completion
                    && state.time().is_some_and(|at| now.saturating_sub(at) <= 120)
            }
            "failed" => {
                p.notify_on_failure && state.time().is_some_and(|at| now.saturating_sub(at) <= 120)
            }
            _ => false,
        }
}

fn alert(state: &Activity) -> Value {
    json!({"title": state.thread_title, "body": format!("{}: {}", state.status(), state.project_title), "sound": "default"})
}

fn notification_job(token: String, state: &Activity, now: u64) -> Job {
    Job {
        token,
        live: false,
        attempts: 0,
        expires: now + 120,
        fallback: None,
        bindings: Vec::new(),
        payload: json!({"aps": {"alert": alert(state), "sound": "default", "thread-id": format!("{}/{}", state.environment_id, state.thread_id)}, "body": {"environmentId": state.environment_id, "threadId": state.thread_id, "deepLink": state.deep_link}}),
    }
}

fn live_job(
    token: String,
    aggregate: Option<&Value>,
    alert_state: Option<&Activity>,
    now: u64,
) -> Job {
    let ending = aggregate.is_none_or(|state| state["activeCount"] == 0);
    let mut payload =
        json!({"aps": {"event": if ending {"end"} else {"update"}, "timestamp": now}});
    payload["aps"][if ending {
        "dismissal-date"
    } else {
        "stale-date"
    }] = json!(
        now + if ending {
            if aggregate.is_some() { 300 } else { 15 }
        } else {
            600
        }
    );
    if let Some(state) = alert_state {
        payload["aps"]["alert"] = alert(state);
    }
    if let Some(state) = aggregate {
        let mut state = state.clone();
        loop {
            payload["aps"]["content-state"] =
                json!({"name": "SelfHostedAgentActivity", "props": state.to_string()});
            if payload.to_string().len() <= 4096 {
                break;
            }
            if state["activities"]
                .as_array_mut()
                .is_none_or(|rows| rows.pop().is_none())
            {
                break;
            }
        }
    }
    Job {
        token,
        live: true,
        payload,
        attempts: 0,
        expires: now + 600,
        fallback: None,
        bindings: Vec::new(),
    }
}

fn job_authorized(job: &Job, data: &Data) -> bool {
    !job.bindings.is_empty()
        && job.bindings.iter().all(|(environment, session, id)| {
            data.devices.iter().any(|device| {
                &device.environment_id == environment
                    && &device.session_id == session
                    && &device.registration.device_id == id
            })
        })
        && data.devices.iter().any(|device| {
            if job.live {
                device.activity_token.as_ref() == Some(&job.token)
                    && device.registration.preferences.live_activities_enabled
            } else {
                device.registration.push_token.as_ref() == Some(&job.token)
                    && device.registration.preferences.notifications_enabled
            }
        })
}

fn phase_transition_alerts(previous: &Activity, next: &Activity) -> bool {
    let attention = |phase: &str| matches!(phase, "waiting_for_approval" | "waiting_for_input");
    previous.phase != next.phase
        && !(previous.terminal() && next.terminal())
        && !(attention(&previous.phase) && attention(&next.phase))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> Credentials {
        let key = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            &ring::rand::SystemRandom::new(),
        )
        .unwrap();
        Credentials {
            team: "TESTTEAM01".into(),
            key_id: "TESTKEY001".into(),
            key: EncodingKey::from_ec_der(key.as_ref()),
            bundle: "test.t3.app".into(),
            environment: "sandbox".into(),
            client: reqwest::Client::new(),
            jwt: Mutex::new(None),
            endpoint: None,
        }
    }
    fn fixture() -> Push {
        Push::open(
            Connection::open_in_memory().unwrap(),
            credentials(),
            &"secret".repeat(8),
        )
        .unwrap()
    }
    fn input(operation: Value) -> Request {
        let mut value = operation;
        value["environmentId"] = json!("env");
        value["activeSessionIds"] = json!(["session"]);
        serde_json::from_value(value).unwrap()
    }
    fn registration() -> Value {
        json!({"operation":"register", "sessionId":"session", "registration": {
            "deviceId":"device", "platform":"ios", "bundleId":"test.t3.app", "apsEnvironment":"sandbox", "pushToken":"a".repeat(64),
            "preferences":{"notificationsEnabled":true,"liveActivitiesEnabled":true,"notifyOnApproval":true,"notifyOnInput":true,"notifyOnCompletion":true,"notifyOnFailure":true}
        }})
    }
    fn state(phase: &str) -> Activity {
        Activity {
            environment_id: "env".into(),
            thread_id: "thread".into(),
            project_title: "Project".into(),
            thread_title: "Thread".into(),
            model_title: "Model".into(),
            phase: phase.into(),
            updated_at: chrono::DateTime::from_timestamp(now() as i64, 0)
                .unwrap()
                .to_rfc3339(),
            deep_link: "/threads/env/thread".into(),
        }
    }
    async fn publish(push: &Push, phase: &str) {
        push.apply(input(
            json!({"operation":"publish","threadId":"thread","state":state(phase)}),
        ))
        .await
        .unwrap();
    }
    async fn jobs(push: &Push) -> Vec<Job> {
        let store = push.inner.lock().await;
        let mut statement = store
            .db
            .prepare("SELECT data FROM jobs ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|text| serde_json::from_str(&text.unwrap()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn requires_authorization_and_matching_app_identity() {
        let push = fixture();
        let mut headers = HeaderMap::new();
        assert!(!push.authorize(&headers));
        headers.insert(
            "authorization",
            format!("Bearer {}", "secret".repeat(8)).parse().unwrap(),
        );
        assert!(push.authorize(&headers));
        let mut wrong_app = registration();
        wrong_app["registration"]["bundleId"] = json!("other.app");
        assert_eq!(
            push.apply(input(wrong_app)).await.unwrap_err(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let mut revoked = registration();
        revoked["sessionId"] = json!("revoked");
        assert_eq!(
            push.apply(input(revoked)).await.unwrap_err(),
            StatusCode::FORBIDDEN
        );
        assert!(push.inner.lock().await.data.devices.is_empty());
    }

    #[tokio::test]
    async fn deduplicates_transitions_and_obeys_notification_preferences() {
        let push = fixture();
        push.apply(input(registration())).await.unwrap();
        publish(&push, "running").await;
        publish(&push, "waiting_for_approval").await;
        publish(&push, "waiting_for_approval").await;
        let delivered = jobs(&push).await;
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].payload["body"]["threadId"], "thread");
        let mut preferences = registration();
        preferences["registration"]["preferences"]["notifyOnCompletion"] = json!(false);
        push.apply(input(preferences)).await.unwrap();
        publish(&push, "completed").await;
        assert_eq!(jobs(&push).await.len(), 1);
    }

    #[tokio::test]
    async fn replays_rotated_activity_tokens_without_alerting_and_ends_with_final_state() {
        let push = fixture();
        push.apply(input(registration())).await.unwrap();
        publish(&push, "running").await;
        push.apply(input(json!({"operation":"activity","sessionId":"session","deviceId":"device","activityPushToken":"b".repeat(64)}))).await.unwrap();
        push.apply(input(json!({"operation":"activity","sessionId":"session","deviceId":"device","activityPushToken":"c".repeat(64)}))).await.unwrap();
        publish(&push, "completed").await;
        let delivered = jobs(&push).await;
        assert_eq!(delivered.len(), 3);
        assert!(delivered[0].payload["aps"]["alert"].is_null());
        assert_eq!(delivered[2].token, "c".repeat(64));
        assert_eq!(delivered[2].payload["aps"]["event"], "end");
        assert_eq!(
            delivered[2].payload["aps"]["content-state"]["name"],
            "SelfHostedAgentActivity"
        );
        assert!(delivered[2].fallback.is_some());
    }

    #[tokio::test]
    async fn capabilities_reconciliation_revokes_session_bindings() {
        let push = fixture();
        push.apply(input(registration())).await.unwrap();
        publish(&push, "running").await;
        let mut revoked = input(json!({"operation":"capabilities"}));
        revoked.active_session_ids.clear();
        push.apply(revoked).await.unwrap();
        publish(&push, "failed").await;
        assert!(jobs(&push).await.is_empty());
        assert!(push.inner.lock().await.data.devices.is_empty());
    }

    #[tokio::test]
    async fn cancels_already_queued_payloads_after_revocation() {
        let push = fixture();
        push.apply(input(registration())).await.unwrap();
        publish(&push, "running").await;
        publish(&push, "failed").await;
        let queued = jobs(&push).await.pop().unwrap();
        assert!(job_authorized(&queued, &push.inner.lock().await.data));
        let mut revoked = input(json!({"operation":"capabilities"}));
        revoked.active_session_ids.clear();
        push.apply(revoked).await.unwrap();
        assert!(!job_authorized(&queued, &push.inner.lock().await.data));
    }

    #[tokio::test]
    async fn persists_state_and_pending_deliveries_across_reopening() {
        let push = fixture();
        push.apply(input(registration())).await.unwrap();
        publish(&push, "running").await;
        publish(&push, "failed").await;
        let db = std::mem::replace(
            &mut push.inner.lock().await.db,
            Connection::open_in_memory().unwrap(),
        );
        let restarted = Push::open(db, credentials(), &"secret".repeat(8)).unwrap();
        assert_eq!(restarted.inner.lock().await.data.devices.len(), 1);
        assert_eq!(jobs(&restarted).await.len(), 1);
        publish(&restarted, "failed").await;
        assert_eq!(jobs(&restarted).await.len(), 1);
    }

    #[tokio::test]
    async fn sends_apns_headers_and_reuses_provider_tokens() {
        let (requests, mut received) = tokio::sync::mpsc::channel(4);
        let app = Router::new().route(
            "/3/device/{token}",
            post(move |headers: HeaderMap, Json(payload): Json<Value>| {
                let requests = requests.clone();
                async move {
                    requests.send((headers, payload)).await.unwrap();
                    StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await
                .unwrap();
        });
        let mut credentials = credentials();
        credentials.endpoint = Some(format!("http://{address}"));
        let push = Push::open(
            Connection::open_in_memory().unwrap(),
            credentials,
            &"secret".repeat(8),
        )
        .unwrap();
        let state = state("waiting_for_input");
        let notification = notification_job("a".repeat(64), &state, now());
        assert_eq!(push.send(&notification).await.unwrap(), (false, None));
        let (ordinary, payload) = received.recv().await.unwrap();
        assert_eq!(ordinary["apns-push-type"], "alert");
        assert_eq!(ordinary["apns-topic"], "test.t3.app");
        assert_eq!(payload["body"]["deepLink"], "/threads/env/thread");
        let aggregate = json!({"activeCount":1,"activities":[],"title":"T3 Code"});
        push.send(&live_job("b".repeat(64), Some(&aggregate), None, now()))
            .await
            .unwrap();
        let (live, _) = received.recv().await.unwrap();
        assert_eq!(live["apns-push-type"], "liveactivity");
        assert_eq!(live["apns-topic"], "test.t3.app.push-type.liveactivity");
        assert_eq!(live["apns-priority"], "5");
        assert_eq!(ordinary["authorization"], live["authorization"]);
        stop.cancel();
        server.await.unwrap();
    }

    #[test]
    fn limits_multibyte_live_activity_payloads_and_keeps_priority_rows() {
        let mut data = Data::default();
        let device: Registration =
            serde_json::from_value(registration()["registration"].clone()).unwrap();
        data.devices.push(Device {
            environment_id: "env".into(),
            session_id: "session".into(),
            registration: device,
            activity_token: None,
            last_seen: now(),
        });
        for index in 0..10 {
            let mut row = state(if index == 9 {
                "waiting_for_input"
            } else {
                "running"
            });
            row.thread_id = index.to_string();
            row.thread_title = "中文😀".repeat(120);
            data.rows.insert(index.to_string(), row);
        }
        let aggregate = aggregate_for(&data, "device", now()).unwrap();
        assert_eq!(aggregate["activeCount"], 10);
        assert_eq!(aggregate["activities"][0]["phase"], "waiting_for_input");
        let job = live_job("a".repeat(64), Some(&aggregate), None, now());
        assert!(job.payload.to_string().len() <= 4096);
        let mut waiting = state("waiting_for_input");
        waiting.thread_title = "😀".repeat(120);
        waiting.project_title = "中".repeat(120);
        let alerting = live_job("a".repeat(64), Some(&aggregate), Some(&waiting), now());
        assert!(alerting.payload.to_string().len() <= 4096);
        assert!(aggregate_for(&data, "device", now() + 86401).is_none());
    }
}
