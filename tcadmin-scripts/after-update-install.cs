// TCAdmin v3 script — attach to every synced Update's "Update scripts" list,
// with the AfterUpdateInstall event enabled.
//
// Every Update this sync tool creates saves its jar as "minecraft_server.jar" (see
// TCADMIN_BOOTSTRAP_SCRIPT_ID / mcjarfiles-tcadmin-sync), so this script can
// stay generic across all of them: it accepts the EULA and makes sure
// server.properties exists with this service's actual port before the
// customer's first start, without touching the blueprint's own startup
// command or Commandline (leave those exactly as your existing Minecraft
// blueprint already has them configured).
//
// Docs: https://docs.tcadmin.com/3/customizations/scripts/script-objects

//refAssemblies: TCAdmin.SDK.dll, TCAdmin.GameHosting.SDK.dll, TCAdmin.Scripting.dll, TCAdmin.Monitor.dll

using System.IO;

var Globals = new TCAdmin.Scripting.Engines.Addons.CSharpGameGlobals(); // DO NOT MODIFY THIS LINE

var eulaPath = Path.Combine(RootDirectory, "eula.txt");
File.WriteAllText(eulaPath, "eula=true" + System.Environment.NewLine);
ScriptConsole.WriteLine("eula.txt accepted for '{0}'.", ThisService.Name);

var propertiesPath = Path.Combine(RootDirectory, "server.properties");
if (!File.Exists(propertiesPath))
{
    var port = ThisService.GamePort > 0 ? ThisService.GamePort : 25565;
    var queryPort = ThisService.QueryPort > 0 ? ThisService.QueryPort : port;

    File.WriteAllLines(propertiesPath, new[]
    {
        "server-port=" + port,
        "query.port=" + queryPort,
        "enable-query=true",
        "enable-rcon=false",
    });

    ScriptConsole.WriteLine("Created default server.properties (port {0}) for '{1}'.", port, ThisService.Name);
}
else
{
    ScriptConsole.WriteLine("server.properties already present — leaving it as-is.");
}
