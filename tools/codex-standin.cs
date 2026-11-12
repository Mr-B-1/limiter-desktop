// A stand-in for the Codex CLI, used only by the CI smoke test, because a CI runner has no signed-in Codex account.
// It answers the commands Limiter sends to codex.exe with fixed fixture values and never contacts anything.
// The receipt names it by its version, codex-cli 0.0.0-limiter-standin, so a stand-in run is never mistaken for a real one.
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

static class CodexStandin {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") { Console.Out.Write("codex-cli 0.0.0-limiter-standin\n"); return 0; }
    if (args.Length == 2 && args[0] == "app-server" && args[1] == "--help") { Console.Out.Write("Usage: codex app-server [--stdio]\n  --stdio  JSON-RPC over standard input and output\n"); return 0; }
    if (args.Length == 4 && args[0] == "app-server" && args[1] == "generate-json-schema" && args[2] == "--out") { WriteSchema(args[3]); return 0; }
    if (args.Length == 2 && args[0] == "app-server" && args[1] == "--stdio") { Serve(); return 0; }
    Console.Error.WriteLine("codex stand-in: unsupported command");
    return 2;
  }

  // The two schema files Limiter checks before it trusts a Codex build.
  static void WriteSchema(string root) {
    Directory.CreateDirectory(Path.Combine(root, "v2"));
    File.WriteAllText(Path.Combine(root, "v2", "GetAccountRateLimitsResponse.json"),
      "{\"definitions\":{\"RateLimitWindow\":{\"type\":\"object\",\"required\":[\"usedPercent\"],\"properties\":{\"usedPercent\":{\"type\":\"integer\"}," +
      "\"resetsAt\":{\"type\":[\"integer\",\"null\"]},\"windowDurationMins\":{\"type\":[\"integer\",\"null\"]}}}}}");
    File.WriteAllText(Path.Combine(root, "ClientRequest.json"),
      "{\"oneOf\":[{\"method\":\"initialize\"},{\"method\":\"account/read\"},{\"method\":\"account/rateLimits/read\"}]}");
  }

  // One JSON object per line in each direction, as the real app server speaks.
  static void Serve() {
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.NewLine = "\n";
    output.AutoFlush = true;
    var request = new Regex("^\\{\"id\":(\\d+),\"method\":\"([^\"]+)\"");
    string line;
    while ((line = input.ReadLine()) != null) {
      var match = request.Match(line);
      // Notifications such as "initialized" carry no id and need no reply.
      if (!match.Success) continue;
      string id = match.Groups[1].Value;
      string method = match.Groups[2].Value;
      string result = "{}";
      if (method == "account/read") result = "{\"account\":{\"type\":\"chatgpt\",\"email\":\"standin@example.invalid\",\"planType\":\"pro\"}}";
      if (method == "account/rateLimits/read") {
        long resetsAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3 * 86400;
        result = "{\"rateLimitsByLimitId\":{\"codex\":{\"primary\":{\"usedPercent\":32,\"windowDurationMins\":10080,\"resetsAt\":" + resetsAt + "}}}}";
      }
      output.WriteLine("{\"id\":" + id + ",\"result\":" + result + "}");
    }
  }
}
