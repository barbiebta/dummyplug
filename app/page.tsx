import type { Metadata } from "next";
import { SingleShotApp } from "./ui/SingleShotApp";

export const metadata: Metadata = {
  title: "dummyplug — MiniMax H3 prompt studio",
  description: "Tag local references and expand one simple request into one continuous MiniMax H3 take.",
};

export default function Home() {
  return <SingleShotApp />;
}
