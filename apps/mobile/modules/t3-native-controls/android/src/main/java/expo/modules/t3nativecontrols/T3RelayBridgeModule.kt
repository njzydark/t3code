package expo.modules.t3nativecontrols

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

private class RelayLocalConnection(val socket: Socket, val route: String) {
  val id = UUID.randomUUID().toString()
  val input = BufferedInputStream(socket.getInputStream(), 64 * 1024)
  val output = socket.getOutputStream()
  var remaining = 0L
  var chunkRemaining = 0L
  var chunked = false
  var headOnly = false
  var responseChunked = false
  var websocketKey: String? = null

  fun take(length: Int): ByteArray {
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val count = input.read(bytes, offset, length - offset)
      check(count > 0) { "Local relay connection closed." }
      offset += count
    }
    return bytes
  }

  fun line(limit: Int): String {
    val bytes = ByteArrayOutputStream()
    var previous = -1
    while (bytes.size() <= limit) {
      val next = input.read()
      check(next >= 0) { "Local relay connection closed." }
      if (previous == 13 && next == 10) {
        val data = bytes.toByteArray()
        return String(data, 0, data.size - 1, Charsets.UTF_8)
      }
      bytes.write(next)
      previous = next
    }
    error("HTTP request line is too large.")
  }

  fun send(bytes: ByteArray) = synchronized(output) {
    output.write(bytes)
    output.flush()
  }

  fun readBody(): String? {
    if (chunked) {
      if (chunkRemaining == 0L) {
        chunkRemaining = line(128).substringBefore(";").toLong(16)
        check(chunkRemaining >= 0) { "Invalid HTTP chunk size." }
        if (chunkRemaining == 0L) return null
      }
      val count = minOf(chunkRemaining, 60L * 1024).toInt()
      val bytes = take(count)
      chunkRemaining -= count
      if (chunkRemaining == 0L) check(take(2).contentEquals(byteArrayOf(13, 10))) { "Invalid HTTP chunk." }
      return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
    if (remaining == 0L) return null
    val count = minOf(remaining, 60L * 1024).toInt()
    val bytes = take(count)
    remaining -= count
    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  fun sendFrame(bytes: ByteArray, opcode: Int) {
    check(bytes.size <= 16 * 1024 * 1024) { "WebSocket message is too large." }
    val frame = ByteArrayOutputStream()
    frame.write(0x80 or opcode)
    when {
      bytes.size < 126 -> frame.write(bytes.size)
      bytes.size <= 65535 -> {
        frame.write(126)
        frame.write((bytes.size ushr 8) and 255)
        frame.write(bytes.size and 255)
      }
      else -> {
        frame.write(127)
        for (shift in 56 downTo 0 step 8) frame.write(((bytes.size.toLong() ushr shift) and 255).toInt())
      }
    }
    frame.write(bytes)
    send(frame.toByteArray())
  }

  fun readFrame(): Map<String, Any>? {
    val message = ByteArrayOutputStream()
    var messageType = -1
    while (true) {
      val header = take(2)
      val first = header[0].toInt() and 255
      val second = header[1].toInt() and 255
      val final = first and 0x80 != 0
      val opcode = first and 15
      check(first and 0x70 == 0 && second and 0x80 != 0) { "Invalid WebSocket frame." }
      var length = (second and 127).toLong()
      if (length == 126L || length == 127L) {
        val extended = take(if (length == 126L) 2 else 8)
        length = 0L
        for (byte in extended) {
          check(length <= (16 * 1024 * 1024).toLong()) { "WebSocket frame is too large." }
          length = (length shl 8) or (byte.toLong() and 255)
        }
      }
      check(length in 0..(16L * 1024 * 1024) && message.size() + length <= 16L * 1024 * 1024) {
        "WebSocket message is too large."
      }
      val mask = take(4)
      val bytes = take(length.toInt())
      for (index in bytes.indices) bytes[index] = (bytes[index].toInt() xor mask[index % 4].toInt()).toByte()
      if (opcode >= 8) {
        check(final && length <= 125) { "Invalid WebSocket control frame." }
        when (opcode) {
          8 -> { sendFrame(bytes, 8); return null }
          9 -> { sendFrame(bytes, 10); continue }
          10 -> continue
          else -> error("Unsupported WebSocket frame.")
        }
      }
      if (opcode == 1 || opcode == 2) {
        check(messageType == -1) { "Invalid WebSocket fragment." }
        messageType = opcode
      } else check(opcode == 0 && messageType != -1) { "Invalid WebSocket fragment." }
      message.write(bytes)
      if (final) return mapOf("data" to Base64.encodeToString(message.toByteArray(), Base64.NO_WRAP), "binary" to (messageType == 2))
    }
  }
}

class T3RelayBridgeModule : Module() {
  private val executor = Executors.newCachedThreadPool()
  private val listeners = ConcurrentHashMap<String, ServerSocket>()
  private val connections = ConcurrentHashMap<String, RelayLocalConnection>()

  private fun connection(id: String) = connections[id] ?: error("Local relay connection closed.")
  private fun close(id: String) {
    val connection = connections.remove(id) ?: return
    runCatching { connection.socket.close() }
    sendEvent("closed", mapOf("id" to id))
  }

  private fun task(promise: Promise, operation: () -> Any?) {
    executor.execute {
      try { promise.resolve(operation()) }
      catch (error: Exception) { promise.reject("ERR_RELAY_BRIDGE", "Local relay operation failed.", error) }
    }
  }

  private fun accept(socket: Socket, route: String) {
    if (connections.size >= 64) { socket.close(); return }
    socket.tcpNoDelay = true
    socket.soTimeout = 120000
    val connection = RelayLocalConnection(socket, route)
    connections[connection.id] = connection
    executor.execute {
      try {
        val first = connection.line(8192).split(" ")
        check(first.size == 3 && first[2] == "HTTP/1.1" && first[1].startsWith("/") &&
          !first[1].startsWith("//") && !first[1].contains("\\")) { "Invalid HTTP request." }
        val names = linkedMapOf<String, String>()
        var size = 0
        while (true) {
          val line = connection.line(64 * 1024)
          if (line.isEmpty()) break
          size += line.length
          check(size <= 64 * 1024 && line.contains(":")) { "HTTP headers are too large." }
          val name = line.substringBefore(":").lowercase()
          check(!names.containsKey(name)) { "Duplicate HTTP header." }
          names[name] = line.substringAfter(":").trim()
        }
        connection.headOnly = first[0] == "HEAD"
        names["content-length"]?.let { connection.remaining = it.toLong(); check(connection.remaining >= 0) }
        names["transfer-encoding"]?.let {
          check(names["content-length"] == null && it.lowercase() == "chunked")
          connection.chunked = true
        }
        val websocket = names["upgrade"]?.lowercase() == "websocket"
        if (websocket) {
          val key = names["sec-websocket-key"]
          check(first[0] == "GET" && names["sec-websocket-version"] == "13" && key != null &&
            Base64.decode(key, Base64.DEFAULT).size == 16) { "Invalid WebSocket upgrade." }
          connection.websocketKey = key
        }
        if (names["expect"]?.lowercase() == "100-continue") connection.send("HTTP/1.1 100 Continue\r\n\r\n".toByteArray())
        sendEvent("request", mapOf(
          "id" to connection.id, "route" to route, "method" to first[0], "path" to first[1],
          "headers" to names.map { listOf(it.key, it.value) }, "websocket" to websocket
        ))
      } catch (_: Exception) { close(connection.id) }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("T3RelayBridge")
    Events("request", "closed")
    AsyncFunction("start") { route: String, promise: Promise ->
      task(promise) {
        check(route.matches(Regex("^[a-f0-9]{32}$")))
        synchronized(listeners) {
          listeners[route]?.localPort ?: run {
            val listener = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
            listeners[route] = listener
            executor.execute {
              try { while (!listener.isClosed) accept(listener.accept(), route) }
              catch (_: Exception) { listeners.remove(route, listener) }
            }
            listener.localPort
          }
        }
      }
    }
    AsyncFunction("stop") { route: String, promise: Promise ->
      task(promise) {
        synchronized(listeners) { listeners.remove(route)?.close() }
        connections.values.filter { it.route == route }.forEach { close(it.id) }
        null
      }
    }
    AsyncFunction("read") { id: String, promise: Promise -> task(promise) { connection(id).readBody() } }
    AsyncFunction("respond") { id: String, status: Int, headers: List<List<String>>, promise: Promise ->
      task(promise) {
        check(status in 200..599)
        val connection = connection(id)
        connection.headOnly = connection.headOnly || status in listOf(204, 205, 304)
        connection.responseChunked = !connection.headOnly && headers.none { it.size == 2 && it[0].lowercase() == "content-length" }
        val head = StringBuilder("HTTP/1.1 $status Relay\r\nConnection: close\r\n")
        if (connection.responseChunked) head.append("Transfer-Encoding: chunked\r\n")
        for (header in headers) {
          check(header.size == 2 && header.none { it.contains("\r") || it.contains("\n") })
          if (header[0].lowercase() !in listOf("connection", "transfer-encoding"))
            head.append("${header[0]}: ${header[1]}\r\n")
        }
        connection.send(head.append("\r\n").toString().toByteArray())
        null
      }
    }
    AsyncFunction("write") { id: String, base64: String, promise: Promise ->
      task(promise) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        check(bytes.size <= 60 * 1024)
        if (bytes.isNotEmpty()) {
          val connection = connection(id)
          val output = ByteArrayOutputStream()
          if (connection.responseChunked) output.write("${bytes.size.toString(16)}\r\n".toByteArray())
          output.write(bytes)
          if (connection.responseChunked) output.write("\r\n".toByteArray())
          connection.send(output.toByteArray())
        }
        null
      }
    }
    AsyncFunction("finish") { id: String, promise: Promise ->
      task(promise) { val connection = connection(id); if (connection.responseChunked) connection.send("0\r\n\r\n".toByteArray()); null }
    }
    Function("close") { id: String -> close(id) }
    AsyncFunction("upgrade") { id: String, protocolName: String, promise: Promise ->
      task(promise) {
        val connection = connection(id)
        val key = connection.websocketKey ?: error("Invalid WebSocket upgrade.")
        check(!protocolName.contains("\r") && !protocolName.contains("\n"))
        val accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()), Base64.NO_WRAP)
        val head = StringBuilder("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n")
        if (protocolName.isNotEmpty()) head.append("Sec-WebSocket-Protocol: $protocolName\r\n")
        connection.send(head.append("\r\n").toString().toByteArray())
        null
      }
    }
    AsyncFunction("readSocket") { id: String, promise: Promise -> task(promise) { connection(id).readFrame() } }
    AsyncFunction("writeSocket") { id: String, base64: String, binary: Boolean, promise: Promise ->
      task(promise) { connection(id).sendFrame(Base64.decode(base64, Base64.DEFAULT), if (binary) 2 else 1); null }
    }
    OnDestroy {
      listeners.values.forEach { runCatching { it.close() } }
      connections.keys.toList().forEach { close(it) }
      listeners.clear()
      executor.shutdownNow()
    }
  }
}
