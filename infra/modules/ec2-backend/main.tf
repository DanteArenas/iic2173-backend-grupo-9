resource "aws_instance" "backend" {
  ami           = "ami-0cfde0ea8edd312d4"
  instance_type = "t3.micro"
  key_name      = "properties-market"

  subnet_id = "subnet-0e306dd668dc09f68"

  vpc_security_group_ids = [
    "sg-00a7d282c3c918182"
  ]

  associate_public_ip_address = true

  root_block_device {
    volume_size           = 16
    volume_type           = "gp3"
    delete_on_termination = true
    iops                  = 3000
    throughput            = 125
  }


  tags = {
    Name = "Properties Market"
  }
}
