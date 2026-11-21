on run argv
    if (count of argv) is not 5 then error "Offline Ethernet requires five arguments."

    set actionName to item 1 of argv
    set nodePath to item 2 of argv
    set helperPath to item 3 of argv
    set statePath to item 4 of argv
    set interfaceName to item 5 of argv

    if actionName is "start" then
        set commandText to quoted form of nodePath & " " & quoted form of helperPath & " start --interface " & quoted form of interfaceName & " --state-dir " & quoted form of statePath
    else if actionName is "stop" or actionName is "restore" then
        set commandText to quoted form of nodePath & " " & quoted form of helperPath & " " & actionName & " --state-dir " & quoted form of statePath
    else
        error "Unknown Offline Ethernet action."
    end if

    do shell script commandText with administrator privileges
    return actionName
end run
