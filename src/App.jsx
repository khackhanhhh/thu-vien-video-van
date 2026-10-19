
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

const BUCKET = "lesson-videos";

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
    setMessage("Đang upload video...");

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      setLoading(false);
      setMessage("Upload thất bại: " + uploadError.message);
      return;
    }

    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(path);

    const { error: dbError } = await supabase.from("videos").insert({
      title: title.trim(),
      storage_path: path,
      public_url: urlData.publicUrl,
    });

    if (dbError) {
      await supabase.storage.from(BUCKET).remove([path]);
      setLoading(false);
      setMessage("Không lưu được thông tin video: " + dbError.message);
      return;
    }

    setTitle("");
    setFile(null);
    e.target.reset();
    await loadVideos();
    setLoading(false);
    setMessage("Upload video thành công!");
  }

  async function deleteVideo(video) {
    if (!isAdmin) return;

    const confirmed = window.confirm(
      `Bạn có chắc muốn xóa "${video.title}" không?`
    );
    if (!confirmed) return;

    setLoading(true);

    const { error: fileError } = await supabase.storage
      .from(BUCKET)
      .remove([video.storage_path]);

    if (fileError) {
      setLoading(false);
      setMessage("Không xóa được file: " + fileError.message);
      return;
    }

    const { error: dbError } = await supabase
      .from("videos")
      .delete()
      .eq("id", video.id);

    setLoading(false);

    if (dbError) {
      setMessage("File đã xóa nhưng chưa xóa được bản ghi: " + dbError.message);
      return;
    }

    setVideos((current) => current.filter((v) => v.id !== video.id));
    setMessage("Đã xóa video.");
  }

  const filteredVideos = videos.filter((video) =>
    video.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="site">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-icon">▶</span>
          Video<span className="brand-accent">Library</span>
        </a>

        <div className="top-actions">
          <span className="video-count">{videos.length} video</span>
          <button
            className="admin-toggle"
            onClick={() => setAdminOpen(!adminOpen)}
          >
            {isAdmin ? "Quản trị" : "Đăng nhập quản trị"}
          </button>
        </div>
      </header>

      {adminOpen && (
        <section className="admin-panel">
          {isAdmin ? (
            <>
              <div className="admin-heading">
                <div>
                  <h2>Quản lý thư viện</h2>
                  <p>Bạn đang đăng nhập với quyền quản trị.</p>
                </div>
                <button className="outline-btn" onClick={logout}>
                  Đăng xuất
                </button>
              </div>

              <form className="upload-form" onSubmit={uploadVideo}>
                <label>
                  Tiêu đề video
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Nhập tiêu đề video"
                    required
                  />
                </label>

                <label>
                  Chọn video từ máy tính
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    required
                  />
                </label>

                {file && (
                  <p className="file-info">
                    {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                )}

                <button className="primary-btn" disabled={loading}>
                  {loading ? "Đang xử lý..." : "↑ Upload video"}
                </button>
              </form>
            </>
          ) : (
            <form className="login-form" onSubmit={login}>
              <h2>Đăng nhập quản trị</h2>
              <p>Chỉ tài khoản quản trị được cấp quyền mới có thể upload.</p>

              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>

              <label>
                Mật khẩu
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>

              <button className="primary-btn" disabled={loading}>
                {loading ? "Đang đăng nhập..." : "Đăng nhập"}
              </button>
            </form>
          )}
        </section>
      )}

      {message && (
        <div className="notice">
          <span>{message}</span>
          <button onClick={() => setMessage("")} aria-label="Đóng">
            ×
          </button>
        </div>
      )}

      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">KHO VIDEO CỦA BẠN</span>
            <h1>
              Mọi câu chuyện,
              <br />
              <span>trong một thư viện.</span>
            </h1>
            <p>
              Khám phá và thưởng thức những video được tuyển chọn,
              ở bất cứ đâu và trên mọi thiết bị.
            </p>
            <a href="#library" className="hero-link">
              Khám phá thư viện <span>↓</span>
            </a>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-play">▶</div>
            <span className="art-label">YOUR VIDEO SPACE</span>
          </div>
        </section>

        <section className="library" id="library">
          <div className="section-heading">
            <div>
              <span className="eyebrow">THƯ VIỆN</span>
              <h2>Video mới nhất</h2>
            </div>
            <input
              className="search"
              type="search"
              placeholder="⌕  Tìm video..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {filteredVideos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">▷</div>
              <h3>{search ? "Không tìm thấy video" : "Thư viện đang chờ bạn"}</h3>
              <p>
                {search
                  ? "Thử tìm bằng một từ khóa khác."
                  : "Các video bạn upload sẽ xuất hiện tại đây."}
              </p>
              {!search && !isAdmin && (
                <button
                  className="outline-btn"
                  onClick={() => setAdminOpen(true)}
                >
                  Đăng nhập để upload
                </button>
              )}
            </div>
          ) : (
            <div className="video-grid">
              {filteredVideos.map((video) => (
                <article className="video-card" key={video.id}>
                  <div className="video-player">
                    <video
                      controls
                      preload="metadata"
                      playsInline
                      src={video.public_url}
                    >
                      Trình duyệt của bạn không hỗ trợ phát video.
                    </video>
                  </div>
                  <div className="video-info">
                    <div className="video-title-row">
                      <h3>{video.title}</h3>
                      {isAdmin && (
                        <button
                          className="delete-btn"
                          disabled={loading}
                          onClick={() => deleteVideo(video)}
                          title="Xóa video"
                          aria-label={`Xóa ${video.title}`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <p>
                      Đăng ngày{" "}
                      {new Date(video.created_at).toLocaleDateString("vi-VN")}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer>
        <a className="brand" href="#">
          <span className="brand-icon">▶</span>
          Video<span className="brand-accent">Library</span>
        </a>
        <span>Thư viện video của bạn · © {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
