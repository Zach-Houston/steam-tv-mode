local millennium = require("millennium")

-- Log file lives in the project folder so it can be read without devtools.
local LOG_PATH = millennium.steam_path() .. "/millennium/themes/steam-tv-mode/tvmode.log"
local MAX_BYTES = 512 * 1024

---@ffi
--- Append one line to tvmode.log (truncates when it grows past 512 KB)
---@param line string
---@return boolean
function append_log(line)
    local existing = io.open(LOG_PATH, "r")
    if existing then
        local size = existing:seek("end")
        existing:close()
        if size and size > MAX_BYTES then
            os.remove(LOG_PATH)
        end
    end
    local f = io.open(LOG_PATH, "a")
    if not f then
        return false
    end
    f:write(tostring(line), "\n")
    f:close()
    return true
end

-- Escape hatch for a forgotten unlock code: create a file named "reset-lock"
-- in the project folder; the next Steam start clears the code.
local RESET_PATH = millennium.steam_path() .. "/millennium/themes/steam-tv-mode/reset-lock"

---@ffi
--- True (once) if the reset-lock file exists; the file is removed.
---@return boolean
function lock_reset_requested()
    local f = io.open(RESET_PATH, "r")
    if not f then
        return false
    end
    f:close()
    os.remove(RESET_PATH)
    return true
end

-- Captured Steam icons are saved as files so they only ever need capturing once.
local ICON_DIR = millennium.steam_path() .. "/millennium/themes/steam-tv-mode/icons/"
local ICON_NAMES = { achievement = true, perfect = true, controller = true, settings = true }

---@ffi
--- Save a captured SVG icon ("achievement" or "perfect") into the project's icons folder.
---@param name string
---@param svg string
---@return boolean
function save_icon(name, svg)
    if not ICON_NAMES[name] or type(svg) ~= "string" or not svg:match("^<svg") then
        return false
    end
    local f = io.open(ICON_DIR .. name .. ".svg", "w")
    if not f then
        return false
    end
    f:write(svg)
    f:close()
    return true
end

---@ffi
--- Load a saved icon; empty string if there isn't one.
---@param name string
---@return string
function read_icon(name)
    if not ICON_NAMES[name] then
        return ""
    end
    local f = io.open(ICON_DIR .. name .. ".svg", "r")
    if not f then
        return ""
    end
    local svg = f:read("*a")
    f:close()
    return svg or ""
end

-- Official announcements / patch notes for a game, from Steam's public news API.
-- Fetched here because the Steam UI's browser context blocks this cross-site request.
---@ffi
--- Returns the raw JSON from ISteamNews/GetNewsForApp, or "" on failure.
---@param appid number
---@return string
function get_news(appid)
    local ok, http = pcall(require, "http")
    if not ok or not http then
        return ""
    end
    local url = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=" .. tostring(math.floor(tonumber(appid) or 0))
        .. "&count=8&maxlength=0&feeds=steam_community_announcements&format=json"
    local res, err = http.get(url, { timeout = 10 })
    if not res then
        return ""
    end
    if type(res) == "string" then
        return res
    end
    if type(res) == "table" then
        return res.body or res.data or res.content or ""
    end
    return ""
end

-- Diagnostics: list Steam's internal browser windows from its debugging endpoint (if enabled).
---@ffi
--- Returns the raw JSON target list from Steam's CEF debugging port, or "" if unavailable.
---@return string
function list_cef_targets()
    local ok, http = pcall(require, "http")
    if not ok or not http then
        return "no-http"
    end
    for _, port in ipairs({ 8080, 8081 }) do
        local res = http.get("http://127.0.0.1:" .. port .. "/json", { timeout = 3 })
        if res then
            if type(res) == "string" then return res end
            if type(res) == "table" then
                local body = res.body or res.data or res.content
                if body then return body end
            end
        end
    end
    return ""
end
