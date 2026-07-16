use std::io::{Read, Write};
use std::net::TcpStream;

/// Build an SSH ProxyCommand for the given proxy string using OpenBSD netcat.
/// Supports http(s)/connect and socks4/socks5. Returns None for empty input.
pub(crate) fn ssh_proxy_command(proxy: &str) -> Option<String> {
    let p = proxy.trim();
    if p.is_empty() {
        return None;
    }
    let (scheme, hostport) = match p.split_once("://") {
        Some((s, hp)) => (s.to_lowercase(), hp.to_string()),
        None => ("http".to_string(), p.to_string()),
    };
    let x = match scheme.as_str() {
        "socks5" | "socks5h" | "socks" => "5",
        "socks4" | "socks4a" => "4",
        _ => "connect", // http / https / anything else → HTTP CONNECT
    };
    // %h/%p are expanded by ssh to the target host/port
    Some(format!("nc -X {} -x {} %h %p", x, hostport))
}

// ---- Proxy dialing (shared by SFTP/FTP) ---------------------------------
// Each connection may carry its OWN optional proxy, completely independent from
// the app-wide claude proxy. We open the TCP connection to the target THROUGH
// the proxy (HTTP CONNECT / SOCKS5 / SOCKS4a) and hand that socket to the
// SFTP/FTP client. Empty proxy = direct connection (never the app proxy).

/// Parse "socks5://127.0.0.1:1080" / "127.0.0.1:8080" → (scheme, host, port).
fn parse_proxy(proxy: &str) -> Option<(String, String, u16)> {
    let p = proxy.trim();
    if p.is_empty() {
        return None;
    }
    let (scheme, rest) = match p.split_once("://") {
        Some((s, r)) => (s.to_lowercase(), r.to_string()),
        None => ("http".to_string(), p.to_string()),
    };
    // drop any path and user:pass@ credentials, keep host:port
    let rest = rest.split('/').next().unwrap_or(&rest);
    let hostport = rest.rsplit('@').next().unwrap_or(rest);
    let (host, port) = hostport.rsplit_once(':')?;
    Some((scheme, host.to_string(), port.parse().ok()?))
}

/// Open a TCP connection to target_host:target_port through the given proxy.
pub(crate) fn connect_via_proxy(proxy: &str, target_host: &str, target_port: u16) -> std::io::Result<TcpStream> {
    let (scheme, phost, pport) = parse_proxy(proxy)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid proxy"))?;
    let mut s = TcpStream::connect((phost.as_str(), pport))?;
    match scheme.as_str() {
        "socks5" | "socks5h" | "socks" => socks5_connect(&mut s, target_host, target_port)?,
        "socks4" | "socks4a" => socks4_connect(&mut s, target_host, target_port)?,
        _ => http_connect(&mut s, target_host, target_port)?, // http / https / connect
    }
    Ok(s)
}

fn io_err(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::other(msg.into())
}

fn http_connect(s: &mut TcpStream, host: &str, port: u16) -> std::io::Result<()> {
    let req = format!(
        "CONNECT {h}:{p} HTTP/1.1\r\nHost: {h}:{p}\r\nProxy-Connection: keep-alive\r\n\r\n",
        h = host,
        p = port
    );
    s.write_all(req.as_bytes())?;
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if s.read(&mut byte)? == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") || buf.len() > 8192 {
            break;
        }
    }
    let resp = String::from_utf8_lossy(&buf);
    let status = resp.lines().next().unwrap_or("");
    if status.contains(" 200") {
        Ok(())
    } else {
        Err(io_err(format!("proxy CONNECT refused: {}", status)))
    }
}

fn socks5_connect(s: &mut TcpStream, host: &str, port: u16) -> std::io::Result<()> {
    // greeting — one method: 0x00 (no auth)
    s.write_all(&[0x05, 0x01, 0x00])?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply)?;
    if reply[0] != 0x05 || reply[1] != 0x00 {
        return Err(io_err("socks5: no acceptable auth method"));
    }
    // CONNECT to domain:port
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head)?;
    if head[1] != 0x00 {
        return Err(io_err(format!("socks5: connect failed (code {})", head[1])));
    }
    let addr_len = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)?;
            l[0] as usize
        }
        _ => return Err(io_err("socks5: bad address type")),
    };
    let mut rest = vec![0u8; addr_len + 2];
    s.read_exact(&mut rest)?; // bound addr + port (ignored)
    Ok(())
}

fn socks4_connect(s: &mut TcpStream, host: &str, port: u16) -> std::io::Result<()> {
    // SOCKS4a: DSTIP 0.0.0.x (x != 0) signals "resolve the trailing hostname"
    let mut req = vec![0x04, 0x01];
    req.extend_from_slice(&port.to_be_bytes());
    req.extend_from_slice(&[0, 0, 0, 1]);
    req.push(0); // empty user id
    req.extend_from_slice(host.as_bytes());
    req.push(0);
    s.write_all(&req)?;
    let mut reply = [0u8; 8];
    s.read_exact(&mut reply)?;
    if reply[1] != 0x5a {
        return Err(io_err(format!("socks4: request rejected (code {})", reply[1])));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ssh_proxy_command;

    #[test]
    fn empty_means_none() {
        assert!(ssh_proxy_command("").is_none());
        assert!(ssh_proxy_command("   ").is_none());
    }

    #[test]
    fn bare_hostport_defaults_to_http_connect() {
        assert_eq!(
            ssh_proxy_command("127.0.0.1:8080").as_deref(),
            Some("nc -X connect -x 127.0.0.1:8080 %h %p")
        );
    }

    #[test]
    fn socks5_scheme() {
        assert_eq!(
            ssh_proxy_command("socks5://127.0.0.1:1080").as_deref(),
            Some("nc -X 5 -x 127.0.0.1:1080 %h %p")
        );
    }

    #[test]
    fn socks4_scheme() {
        assert_eq!(
            ssh_proxy_command("socks4://10.0.0.1:9050").as_deref(),
            Some("nc -X 4 -x 10.0.0.1:9050 %h %p")
        );
    }

    #[test]
    fn https_scheme_maps_to_connect() {
        assert_eq!(
            ssh_proxy_command("https://proxy:3128").as_deref(),
            Some("nc -X connect -x proxy:3128 %h %p")
        );
    }
}
