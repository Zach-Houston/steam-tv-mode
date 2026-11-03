-- TV Mode does all of its work in the Steam UI (frontend/index.tsx).
-- This backend only exists because Millennium expects one; it just reports in.
local logger     = require("logger")
local millennium = require("millennium")

-- registers the append_log FFI function used by the frontend
require("log_file")

local function on_load()
    logger:info("TV Mode loaded (Millennium " .. millennium.version() .. ")")
    millennium.ready()
end

local function on_unload()
    logger:info("TV Mode unloaded")
end

local function on_frontend_loaded()
    logger:info("TV Mode: Steam UI ready")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
