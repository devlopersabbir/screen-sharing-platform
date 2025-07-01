import { useEffect, useState } from "react";
import { web_socket } from "../libs/socket";

const ActiveUsers = () => {
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    const handleActiveUsers = (data: string[]) => {
      console.log("Active users:", data);
      setUsers(data);
    };

    // Register listener
    web_socket.on("active_users", handleActiveUsers);

    return () => {
      web_socket.off("active_users", handleActiveUsers);
    };
  }, []);

  return (
    <div className="mt-2">
      <p className="text-green-500 text-sm">
        Online Users: <b className="">#{users.length}</b>
      </p>
    </div>
  );
};

export default ActiveUsers;
