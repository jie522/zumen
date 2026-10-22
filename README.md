# ZUMEN 手機版

[ZUMEN](https://zume-n.com) 圖面管理的手機介面：**快速搜尋圖面、檢視圖面與檔案、在現場直接錄影上傳、觀看加工影片**。

電腦版請見 [jie522/260704-zumen](https://github.com/jie522/260704-zumen)，本專案沿用它的 ZUMEN API 實測結論。

## 運作方式

```
手機瀏覽器 ──Wi-Fi──▶ 公司電腦（node server.js，port 3457）──▶ zume-n.com
```

ZUMEN 沒有公開 API，必須由一台電腦用瀏覽器自動登入後代為存取，所以：

- 一台電腦開著伺服器，手機連**同一個 Wi-Fi** 就能用，手機不用裝 App
- 影片／圖檔直接從 ZUMEN 的雲端串流到手機，不經過電腦
- 上傳時手機先把檔案傳給電腦，電腦再自動上傳到 ZUMEN（大影片需要幾分鐘，期間可以繼續瀏覽）

## 功能

| 功能 | 說明 |
|---|---|
| 快速搜尋 | 打圖號、品名任一段即時搜尋，關鍵字反白；往下滑自動載入更多 |
| 最近看過 | 首頁保留最近 12 張看過的圖面，一鍵回去 |
| 圖面檢視 | 大圖預覽、生產線別／群組等欄位、各分類檔案數量 |
| 影片總覽 | 自動彙整這張圖面所有分類裡的影片，橫向滑動挑選，點了直接播放 |
| 錄影上傳 | 「錄影」直接開相機、「拍照」、「相簿/檔案」可多選；可先取檔名、選分類 |
| 檔案預覽 | 圖片可兩指縮放；PDF、Excel 用手機內建程式開啟 |
| 加入主畫面 | 支援「加入主畫面」，像 App 一樣全螢幕開啟 |

## 安裝（第一次）

```bash
git clone https://github.com/jie522/zumen.git
cd zumen
npm install
copy .env.example .env      # 打開 .env 填入 ZUMEN_EMAIL / ZUMEN_PASSWORD
node server.js
```

- 電腦需要裝 Microsoft Edge 或 Chrome（Windows 內建 Edge 即可）
- **小技巧**：如果這台電腦已在用電腦版，把電腦版資料夾裡的 `.auth-session.json` 複製過來，第一次啟動就不必再登入
- 之後可以直接雙擊 `start-zumen-mobile.vbs` 背景啟動

## 手機怎麼連

1. 電腦開 `http://localhost:3457/connect.html`，畫面會出現 QR Code
2. 手機（同一個 Wi-Fi）用相機掃描開啟
3. 瀏覽器選單 →「加入主畫面」，之後從主畫面圖示開

連不上時：確認手機跟電腦在同一個網路；Windows 防火牆第一次跳出詢問時要按「允許」（或手動開放 TCP 3457）。

## 設定（.env）

| 變數 | 說明 |
|---|---|
| `ZUMEN_EMAIL` / `ZUMEN_PASSWORD` | ZUMEN 帳密（只在登入過期時用到） |
| `ACCESS_PIN` | 手機進入時要輸入的通行碼；留空代表同 Wi-Fi 的人都能直接用 |
| `PORT` | 預設 3457（電腦版用 3456，兩個可以同時開） |

## 注意

- `.env`、`.auth-session.json` 含帳號資訊，已在 `.gitignore` 排除，**不要提交到 GitHub**（這個 repo 是公開的）
- 上傳是自動操作 ZUMEN 網頁完成的，ZUMEN 改版時上傳可能失效，修法參考電腦版 `docs/ZUMEN-API.md`
- 短時間內不要反覆重啟伺服器：每次帳密登入失敗都會累積，太多次會被 ZUMEN（Auth0）鎖帳號
- iPhone 錄的影片（HEVC .mov）在部分 Android 手機無法直接播放，畫面會提供下載連結
