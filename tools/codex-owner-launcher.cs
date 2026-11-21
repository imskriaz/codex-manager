using System;
using System.IO;
using System.Diagnostics;

public static class CodexOwnerLauncher {
    static string Quote(string value) {
        var result = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    public static int Main(string[] args) {
        try {
            string root = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string[] config = File.ReadAllLines(Path.Combine(root, "launcher.txt"));
            var info = new ProcessStartInfo(config[0]);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.Arguments = Quote(config[1]) + " " + Quote(Path.Combine(root, "owner.json"));
            foreach (string arg in args) info.Arguments += " " + Quote(arg);
            info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (var child = Process.Start(info)) {
                var input = Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);
                input.ContinueWith(task => child.StandardInput.Close());
                var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                child.WaitForExit(); System.Threading.Tasks.Task.WaitAll(output, error); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
