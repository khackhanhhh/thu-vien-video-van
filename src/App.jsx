import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const R2_PUBLIC_BASE_URL = (
  import.meta.env.VITE_R2_PUBLIC_BASE_URL || ""
).replace(/\/+$/, "");

async function postApi(path, body) {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session?.access_token) {
    throw new Error(
      "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
    );
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `Yêu cầu thất bại (HTTP ${response.status})`
    );
  }

  return data;
}

async function uploadVideoToR2(file) {
  if (!R2_PUBLIC_BASE_URL) {
    throw new Error("Chưa cấu hình VITE_R2_PUBLIC_BASE_URL.");
  }

  const { key, uploadId, partSize, partCount } = await postApi(
    "/api/uploads/init",
    {
      fileName: file.name,
      contentType: file.type,
      size: file.size,
    }
  );

  const parts = [];

  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, file.size);
      const chunk = file.slice(start, end);

      const { url } = await postApi("/api/uploads/part-url", {
        key,
        uploadId,
        partNumber,
      });

      const response = await fetch(url, {
        method: "PUT",
        body: chunk,
      });

      if (!response.ok) {
        throw new Error(`Upload phần ${partNumber} thất bại.`);
      }

      const etag = response.headers.get("ETag");

      if (!etag) {
        throw new Error(
          "Không đọc được ETag. Hãy kiểm tra CORS của bucket R2."
        );
      }

      parts.push({ PartNumber: partNumber, ETag: etag });
    }

    await postApi("/api/uploads/complete", {
      key,
      uploadId,
      parts,
    });

    return {
      key,
      storagePath: `r2:${key}`,
      publicUrl: `${R2_PUBLIC_BASE_URL}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    };
  } catch (error) {
    try {
      await postApi("/api/uploads/abort", { key, uploadId });
    } catch {
      // Giữ nguyên lỗiupload
    }
    throw error;
  }
}

export default function App() {
  const [videos, setVideos] = useState([]);
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState(null);

  const isAdmin = user?.app_metadata?.role === "admin";

  async function loadVideos() {
    const { data, error } = await supabase
      .from("videos")
      .select("id, title, storage_path, public_url, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      setMessage("Không tải được danh sách video: " + error.message);
      return;
    }

    setVideos(data || []);
  }

  useEffect(() => {
    loadVideos();

    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user || null);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedVideo) return;

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setSelectedVideo(null);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [selectedVideo]);

  async function login(e) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setMessage("Đăng nhập thất bại: " + error.message);
      return;
    }

    if (data.user?.app_metadata?.role !== "admin") {
      await supabase.auth.signOut();
      setMessage("Tài khoản này chưa được cấp quyền quản trị.");
      return;
    }

    setPassword("");
    setMessage("Đăng nhập quản trị thành công.");
  }

  async function logout() {
    await supabase.auth.signOut();
    setMessage("Bạn đã đăng xuất.");
  }

  async function uploadVideo(e) {
    e.preventDefault();

    if (!isAdmin) {
      setMessage("Bạn cần đăng nhập bằng tài khoản quản trị.");
      return;
    }

    if (!title.trim() || !file) {
      setMessage("Hãy nhập tiêu đề và chọn file video.");
      return;
    }

    if (!file.type.startsWith("video/")) {
      setMessage("Vui lòng chọn một file video hợp lệ.");
      return;
    }

    setLoading(true);
    setMessage("Đang upload video lên Cloudflare R2...");

    let uploaded = null;

    try {
      uploaded = await uploadVideoToR2(file);

      const { error: dbError } = await supabase.from("videos").insert({
        title: title.trim(),
        storage_path: uploaded.storagePath,
        public_url: uploaded.publicUrl,
      });

      if (dbError) {
        try {
          await postApi("/api/objects/delete", { key: uploaded.key });
        } catch {
          console.error("Không thể dọn file R2 sau khi lưu metadata thất bại.");
        }

        throw new Error(
          "Video đã upload nhưng không lưu được thông tin: " + dbError.message
        );
      }

      setTitle("");
      setFile(null);

      if (e.currentTarget instanceof HTMLFormElement) {
        e.currentTarget.reset();
      }

      await loadVideos();
      setMessage("Upload video lên R2 thành công!");
    } catch (error) {
      setMessage("Upload thất bại: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteVideo(video) {
    if (!isAdmin) return;

    const confirmed = window.confirm(
      `Bạn có chắc muốn xóa "${video.title}" không?`
    );

    if (!confirmed) return;

    setLoading(true);

    try {
      const r2Key = video.storage_path.startsWith("r2:")
        ? video.storage_path.replace("r2:", "")
        : video.storage_path;

      await postApi("/api/objects/delete", { key: r2Key });

      const { error: dbError } = await supabase
        .from("videos")
        .delete()
        .eq("id", video.id);

      if (dbError) {
        throw new Error("File trên R2 đã xóa nhưng bản ghi lỗi: " + dbError.message);
      }

      if (selectedVideo?.id === video.id) {
        setSelectedVideo(null);
      }

      setVideos((current) => current.filter((v) => v.id !== video.id));
      setMessage("Đã xóa video.");
    } catch (error) {
      setMessage("Xóa video thất bại: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  const filteredVideos = videos.filter((video) =>
    video.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="site-wrapper">
      {/* HEADER NỀN XANH DƯƠNG ĐẬM */}
      <header className="main-header">
        <div className="header-container">
          <div className="brand-box">
            <div className="brand-logo">📖</div>
            <div className="brand-info">
              <div className="brand-name">HỌC LIỆU SỐ</div>
              <div className="brand-sub">NGÀNH SƯ PHẠM NGỮ VĂN</div>
            </div>
          </div>

          <nav className="nav-menu">
            <a href="#" className="nav-link active">
              <span className="nav-icon">🏷</span> Trang chủ
            </a>
            <a href="#library" className="nav-link">
              <span className="nav-icon">▶</span> Thư viện video
            </a>
            <a href="#" className="nav-link">
              <span className="nav-icon">📖</span> Chủ đề học liệu
            </a>
            <a href="#" className="nav-link">
              <span className="nav-icon">👤</span> Giới thiệu
            </a>
          </nav>

          <button
            className="btn-admin-login"
            onClick={() => setAdminOpen(!adminOpen)}
          >
            ⚙ {isAdmin ? "Quản trị" : "Đăng nhập"}
          </button>
        </div>
      </header>

      {/* PANEL QUẢN TRỊ / UPLOAD */}
      {adminOpen && (
        <section className="admin-section">
          <div className="admin-container">
            {isAdmin ? (
              <>
                <div className="admin-header-row">
                  <div>
                    <h3>Quản lý kho học liệu</h3>
                    <p>Bạn đang đăng nhập với quyền quản trị viên.</p>
                  </div>
                  <button className="btn-logout" onClick={logout}>
                    Đăng xuất
                  </button>
                </div>

                <form className="admin-form" onSubmit={uploadVideo}>
                  <div className="form-group">
                    <label>Tiêu đề video học liệu</label>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Nhập tên bài học / tác phẩm..."
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Chọn video</label>
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      required
                    />
                  </div>
                  {file && (
                    <div className="file-size-info">
                      Dung lượng: {(file.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  )}
                  <button className="btn-submit-upload" disabled={loading}>
                    {loading ? "Đang upload..." : "Tải video lên R2"}
                  </button>
                </form>
              </>
            ) : (
              <form className="admin-form" onSubmit={login}>
                <h3>Đăng nhập Quản trị</h3>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Mật khẩu</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button className="btn-submit-upload" disabled={loading}>
                  {loading ? "Đang xử lý..." : "Đăng nhập"}
                </button>
              </form>
            )}
          </div>
        </section>
      )}

      {message && (
        <div className="toast-notification">
          <span>{message}</span>
          <button onClick={() => setMessage("")}>×</button>
        </div>
      )}

      {/* HERO BANNER NỀN KEM KHỚP 100% ẢNH MẪU */}
      <section className="hero-banner">
        <div className="hero-container">
          <div className="hero-text-content">
            <span className="hero-subtitle-tag">— KHO HỌC LIỆU SỐ NGỮ VĂN</span>
            <h1 className="hero-title">
              ỨNG DỤNG VIDEO AI VÀO <br />
              <span className="highlight-text">DẠY HỌC NGỮ VĂN</span>
            </h1>
            <p className="hero-description">
              Khám phá những video học liệu sáng tạo, ứng dụng trí tuệ nhân tạo
              để làm mới phương pháp dạy học Ngữ văn.
            </p>
            <button
              className="btn-primary-explore"
              onClick={() =>
                document
                  .getElementById("library")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Khám phá học liệu →
            </button>
          </div>

          <div className="hero-media-box">
            <div className="screen-frame">
              <div className="screen-content">
                <div className="screen-play-btn">▶</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* THƯ VIỆN VIDEO (DẠNG THẺ NGANG KHỚP 100% MẪU) */}
      <section className="library-section" id="library">
        <div className="library-container">
          <div className="section-head-row">
            <div>
              <span className="section-sub-tag">— THƯ VIỆN VIDEO AI</span>
              <h2 className="section-main-title">
                Các video học liệu phục vụ dạy học Ngữ văn ở trường phổ thông[cite: 1, 2]
              </h2>
            </div>

            <div className="search-box">
              <span className="search-icon">🔍</span>
              <input
                type="search"
                placeholder="Tìm video học liệu..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {filteredVideos.length === 0 ? (
            <div className="empty-video-state">
              <h3>{search ? "Không tìm thấy video" : "Chưa có video nào"}</h3>
              <p>Hãy tải lên video học liệu mới nhất của bạn.</p>
            </div>
          ) : (
            <div className="video-horizontal-grid">
              {filteredVideos.map((video) => (
                <article
                  className="horizontal-video-card"
                  key={video.id}
                  onClick={() => setSelectedVideo(video)}
                >
                  <div className="card-thumb-wrapper">
                    <video
                      src={video.public_url}
                      preload="metadata"
                      playsInline
                      muted
                    />
                    <div className="thumb-play-overlay">
                      <div className="play-icon-circle">▶</div>
                    </div>
                  </div>

                  <div className="card-body-content">
                    <div className="card-header-line">
                      <h3 className="card-video-title">{video.title}</h3>
                      {isAdmin && (
                        <button
                          className="btn-card-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteVideo(video);
                          }}
                          title="Xóa video"
                        >
                          ×
                        </button>
                      )}
                    </div>

                    <p className="card-video-desc">
                      Khám phá học liệu số sinh động ứng dụng AI hỗ trợ bài giảng Ngữ văn.
                    </p>

                    <div className="card-footer-meta">
                      <span className="meta-time">⏱ 5:32</span>
                      <span className="meta-tag">Ngữ văn</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* MODAL XEM VIDEO */}
      {selectedVideo && (
        <div className="modal-backdrop" onClick={() => setSelectedVideo(null)}>
          <div
            className="modal-video-window"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close-btn"
              onClick={() => setSelectedVideo(null)}
            >
              ×
            </button>
            <video
              key={selectedVideo.id}
              src={selectedVideo.public_url}
              controls
              autoPlay
              playsInline
            />
            <div className="modal-video-caption">{selectedVideo.title}</div>
          </div>
        </div>
      )}

      {/* FOOTER */}
      <footer className="main-footer">
        <div className="footer-container">
          <div className="footer-brand">
            <span className="footer-logo">📖</span>
            <strong>HỌC LIỆU SỐ NGÀNH SƯ PHẠM NGỮ VĂN</strong>
          </div>
          <div className="footer-quote">
            — Cùng công nghệ kiến tạo những giờ học Ngữ văn sáng tạo và hiệu quả![cite: 2]
          </div>
        </div>
      </footer>
    </div>
  );
}