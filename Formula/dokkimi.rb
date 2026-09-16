class Dokkimi < Formula
  desc "CLI for isolated Docker environments for microservice testing"
  homepage "https://dokkimi.com"
  url "https://registry.npmjs.org/dokkimi/-/dokkimi-0.5.8.tgz"
  sha256 "4671c5aebd6c5ba1dfa949700086f226eb612a235f5233dff1a4ab765e6a0bd3"
  license "Elastic-2.0"

  depends_on "node"

  def install
    # ignore_scripts: false — dokkimi's postinstall symlinks internal @dokkimi/*
    # packages into node_modules and runs `prisma generate`. Homebrew defaults
    # to --ignore-scripts; we opt in.
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "v#{version}", shell_output("#{bin}/dokkimi --version")
  end
end
