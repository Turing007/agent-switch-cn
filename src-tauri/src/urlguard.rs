use std::io;
use std::net::{IpAddr, ToSocketAddrs};
use url::Url;

/// 出站请求地址白名单校验（与 Electron 版 urlguard 语义一致）：
/// 仅允许公网 http/https 地址，拒绝 localhost、环回、私有和保留地址；
/// 域名会做 DNS 解析，任一解析结果落在保留段同样拒绝（防 DNS rebinding）。
pub async fn assert_public_http_url(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|_| "URL 格式无效".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("仅允许 http/https 地址".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("地址中不允许携带用户名密码".into());
    }
    let host = u
        .host_str()
        .unwrap_or("")
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_string();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err("不允许访问本地/内网地址".into());
    }
    let parsed = host.parse::<IpAddr>().ok();
    match parsed {
        Some(ip) => {
            if is_reserved_ip(&ip) {
                return Err("不允许访问内网/保留地址".into());
            }
            Ok(u)
        }
        None => {
            let port = u.port_or_known_default().unwrap_or(80);
            let addrs: Vec<IpAddr> = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|_| "域名无法解析".to_string())?
                .map(|a| a.ip())
                .collect();
            if addrs.is_empty() {
                return Err("域名无法解析".into());
            }
            if addrs.iter().any(is_reserved_ip) {
                return Err("域名解析到内网/保留地址，已拒绝访问".into());
            }
            Ok(u)
        }
    }
}

pub fn is_reserved_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_reserved_ipv4(*v4),
        IpAddr::V6(v6) => is_reserved_ipv6(*v6),
    }
}

fn is_reserved_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    let (a, b, c) = (o[0], o[1], o[2]);
    if a == 0 || a == 10 || a == 127 {
        return true;
    }
    if a == 100 && (64..=127).contains(&b) {
        return true; // CGNAT
    }
    if a == 169 && b == 254 {
        return true; // link-local
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    if a == 192 && b == 168 {
        return true;
    }
    if a == 192 && b == 0 && c == 0 {
        return true;
    }
    if a == 198 && (b == 18 || b == 19) {
        return true; // benchmark
    }
    a >= 224 // multicast + reserved
}

fn is_reserved_ipv6(ip: std::net::Ipv6Addr) -> bool {
    let seg = ip.segments();
    if seg.iter().all(|&w| w == 0) {
        return true; // ::
    }
    if seg[..7].iter().all(|&w| w == 0) && seg[7] == 1 {
        return true; // ::1
    }
    // IPv4-mapped / IPv4-compatible
    if seg[..5].iter().all(|&w| w == 0) && (seg[5] == 0xffff || seg[5] == 0) {
        let v4 = std::net::Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        );
        if is_reserved_ipv4(v4) {
            return true;
        }
    }
    if (seg[0] & 0xfe00) == 0xfc00 {
        return true; // fc00::/7 unique local
    }
    if (seg[0] & 0xffc0) == 0xfe80 {
        return true; // fe80::/10 link local
    }
    if seg[0] == 0x2001 && seg[1] == 0x0db8 {
        return true; // 文档段
    }
    if seg[0] == 0x0064 && seg[1] == 0xff9b {
        return true; // 64:ff9b::/96 NAT64
    }
    false
}

/// 构建统一请求客户端：禁用自动重定向（防 30x 绕过校验）、限制超时。
/// 仅用于已通过 assert_public_http_url 校验的地址，或固定本机回环的控制通道。
pub fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e: reqwest::Error| io::Error::new(io::ErrorKind::Other, e).to_string())
}
