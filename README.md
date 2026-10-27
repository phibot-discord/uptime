# uptime

Uptime monitor behind the webui's `/status` page. It runs on the assets host,
checks every service once a minute, samples the host's CPU and memory and the
Phira multiplayer server's players, rooms, CPU and memory, keeps 31 days in
SQLite, and serves one JSON summary.