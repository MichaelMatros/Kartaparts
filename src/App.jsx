import { useState} from "react";
import Header from "./Header"; // твой компонент Header
import './index.css';
import './App.css'




export default function App() {
  const [vin, setVin] = useState("");
  const [parts, setParts] = useState([]);
  const [results, setResults] = useState([]);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const API_BASE = "http://localhost:5002";

  const getImageUrl = (img) => {
    if (!img) return "";
    if (img.startsWith("http://") || img.startsWith("https://")) return img;
    return `${API_BASE}/static/${img.replace(/^\/+/, "")}`;
  };

  // 🔧 объединённая функция для поиска
  const handleAction = async () => {
    const q = vin.trim();

    if (!file && !q) {
      alert("Загрузите фото или введите VIN/название детали");
      return;
    }

    setLoading(true);
    setError(null);

    // Очищаем старые результаты перед новым поиском
    setParts([]);
    setResults([]);

    try {
      if (file) {
        // ---- Поиск по изображению ----
        const formData = new FormData();
        formData.append("image", file);

        const res = await fetch(`${API_BASE}/api/search-by-image`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          let text = "";
          try { text = await res.text(); } catch {}
          throw new Error(`Ошибка сервера: ${res.status}${text ? " — " + text : ""}`);
        }

        const data = await res.json();
        const arr = data?.results ?? data ?? [];
        setResults(Array.isArray(arr) ? arr : []);
      } 
      else if (q) {
        // ---- Поиск по VIN ----
        const res = await fetch(`${API_BASE}/api/parts?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          let text = "";
          try { text = await res.text(); } catch {}
          throw new Error(`Ошибка сервера: ${res.status}${text ? " — " + text : ""}`);
        }

        const data = await res.json();
        let arr = [];
        if (Array.isArray(data.parts)) arr = data.parts;
        else if (Array.isArray(data)) arr = data;
        else if (data.part) arr = [data.part];
        setParts(arr);
      }
    } catch (err) {
      console.error("handleAction error", err);
      setError(err.message || "Ошибка при выполнении запроса");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAction();
    }
  };

  // ---- Объединяем все результаты в один массив для вывода ----
  const displayResults = [...results, ...parts];

  return (
    <>
      <Header />

      <div className="page-content">
        <div className="container">
          <h1 className="title">Поиск запчастей по названию/VIN</h1>

          <div className="search-bar" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
  

              {/* Input для VIN */}
              <input
                class="inputtext"
                value={vin}
                onChange={(e) => setVin(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Введите VIN или название детали"
               
              />
            {/* Input для файла с иконкой */}
              <label 
                class="uploadform"
                htmlFor="file-upload" 
              >
                <img 
                  src="/camera.png" 
                  alt="Прикрепить файл" 
                  style={{ width: "28px", height: "28px" }} 
                />
            
                {file ? file.name : ""}
              </label>
              <input
                id="file-upload"
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => setFile(e.target.files[0])}
              />

              {/* Кнопка удаления файла */}
              {file && (
                <button onClick={() => setFile(null)} >
                  ❌
                </button>
              )}
              {/* Общая кнопка */}
              <button class="button1" onClick={handleAction} disabled={loading}>
                {loading ? "Обработка..." : "Искать"}
              </button>
            </div>


          {error && <div className="error-text">{error}</div>}

          <div className="results">
              {loading && <div>Загрузка данных...</div>}

              {!loading && (results.length > 0 || parts.length > 0) && (
              <>
                <h2 className="results-title">
                  Найдено запчастей: {results.length + parts.length}
                </h2>
                <div className="parts-grid">
                  {/* Результаты по фото */}
                  {results.map((p, i) => (
                    <div key={`img-${i}`} className="part-card">
                      <img
                        src={getImageUrl(p.image)}
                        alt={p.name}
                        style={{ width: "100%", height: 180, objectFit: "cover", borderRadius: 6 }}
                      />
                      <div><b>{p.name}</b></div>
                      <div>OEM: {p.oem}</div>
                      <div>Сходство: {(p.score * 100).toFixed(1)}%</div>
                    </div>
                  ))}

        {/* Результаты по VIN */}
        {parts.map((p, i) => (
          <div key={`vin-${i}`} className="part-card">
            <img
              src={
                p.image
                  ? getImageUrl(p.image)
                  : p.images && p.images.length > 0
                    ? getImageUrl(p.images[0])
                    : "https://via.placeholder.com/300x180?text=Нет+фото"
              }
              alt={p.name || "Запчасть"}
              style={{
                width: "100%",
                height: 180,
                objectFit: "cover",
                borderRadius: 6,
                backgroundColor: "#f4f4f4"
              }}
              onError={(e) => {
                e.target.src = "https://via.placeholder.com/300x180?text=Нет+фото";
              }}
            />
            <div><b>{p.name}</b></div>
            <div>OEM: {p.oem}</div>
            <div>Бренд: {p.brand}</div>
            <div>Цена: {p.price} {p.currency}</div>
            <div>Склад: {p.storage}</div>
            <div className="supplier-link">
              <a href={p.supplierUrl || "https://yandex.ru"} target="_blank" rel="noopener noreferrer">
                Перейти к поставщику
              </a>
            </div>
          </div>
        ))}
      </div>
    </>
  )}

  {!loading && results.length === 0 && parts.length === 0 && !error && (
    <div class="placeh">
    <div className="placeholder-text">
      Введите VIN автомобиля или название товара для поиска нужных запчастей. Система подскажет подходящие варианты, ускорит подбор деталей и поможет избежать ошибок при выборе оригинальных или аналоговых комплектующих.
    </div></div>
  )}

  {error && <div className="error-text">{error}</div>}
</div>
</div>
</div>
    </>
  );
 
}
