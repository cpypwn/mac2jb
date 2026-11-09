-- Fix arg table that the game's conf.lua nils out
if arg == nil then arg = {} end

function love.load()
    -- Game's conf.lua sets t.window = false, so create window here
    if love.window and not love.window.isOpen() then
        love.window.setMode(960, 540, {resizable = false})
        love.window.setTitle("GravCirc-Switch-RCE")
    end

    local ok, app = pcall(require, "gc.app")
    if ok then
        app.boot("Gravity Circuit", "gravity-circuit")
    else
        pcall(love.filesystem.append, "gc_log.txt",
            "[main] require gc.app: " .. tostring(app) .. "\n")
        -- Fallback: show error directly
        love.graphics.setBackgroundColor(0.1, 0, 0)
    end
end

function love.update(dt)
end

function love.draw()
    love.graphics.clear(0, 0, 0, 1)
end

function love.keypressed(key)
    if key == "escape" then love.event.quit() end
end

function love.errorhandler(msg)
    local text = "error:\n" .. tostring(msg) .. "\n\n" .. debug.traceback("", 2)
    pcall(love.filesystem.append, "gc_log.txt", "[main] " .. text .. "\n")
    if not (love.graphics and love.event) then return end
    if love.window and not love.window.isOpen() then
        pcall(love.window.setMode, 960, 540)
    end
    local font = love.graphics.newFont(14)
    while true do
        pcall(love.event.pump)
        for e in love.event.poll() do
            if e == "quit" then return end
        end
        pcall(function()
            love.graphics.origin()
            love.graphics.clear(0, 0, 0, 1)
            love.graphics.setColor(1, 1, 1, 1)
            love.graphics.printf(text, font, 12, 12, love.graphics.getWidth() - 24)
            love.graphics.present()
        end)
        if love.timer then love.timer.sleep(0.1) end
    end
end
