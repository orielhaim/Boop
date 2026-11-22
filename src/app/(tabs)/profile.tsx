import { PersonProfile } from "@/components/people/profile";
import { useLocal } from "@/services/local-context";

export default function Profile() {
  const { identity } = useLocal();
  return <PersonProfile publicKey={identity.publicKey} tab />;
}
