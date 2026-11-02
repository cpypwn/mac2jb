on run argv
    if (count of argv) is not 7 then error "DNSwitch launch requires seven arguments."

    set nodePath to item 1 of argv
    set helperPath to item 2 of argv
    set addressText to item 3 of argv
    set hostnameText to item 4 of argv
    set redirectText to item 5 of argv
    set statePath to item 6 of argv
    set tokenPath to item 7 of argv
    set logPath to statePath & ".launch.log"

    set commandText to "trap '' HUP; " & quoted form of nodePath & " " & quoted form of helperPath & " serve --address " & quoted form of addressText & " --hostname " & quoted form of hostnameText & " --url " & quoted form of redirectText & " --state " & quoted form of statePath & " --token-file " & quoted form of tokenPath & " > " & quoted form of logPath & " 2>&1 < /dev/null &"

    do shell script commandText with administrator privileges
    return "started"
end run
